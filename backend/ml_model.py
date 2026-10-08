# ml_model.py
#
# The project's own title is "AI Learning Based Best Path Recommendation
# System" — but the existing Learning Module (learning.py) is a hand-
# tuned formula (recency-weighted median → sigmoid → normalize), not a
# trained model. This module closes that gap: a real scikit-learn
# GradientBoostingRegressor, trained directly on the user_feedback table,
# that predicts how satisfied a user is likely to be with a route BEFORE
# they take it — based on patterns learned from everyone else's actual
# post-trip ratings.
#
# Design mirrors the resilience philosophy already used everywhere else
# in this codebase (learning.py's default-weight fallback, news_ingest.py's
# NEWS_API_KEY gate, reports.py's snap-distance cutoff): if there isn't
# enough data yet, or scikit-learn/joblib aren't installed, or training
# fails for any reason, predict_satisfaction() returns None and callers
# treat that as "no AI prediction available" — it NEVER blocks or breaks
# routing, which keeps working exactly as before regardless.

import os
import threading
import datetime

import numpy as np

from db import get_conn, release_conn, dict_cur

MODEL_DIR = os.path.join(os.path.dirname(__file__), ".ml_cache")
MODEL_PATH = os.path.join(MODEL_DIR, "satisfaction_model.joblib")

# Below this many feedback rows, a GradientBoostingRegressor is more
# likely to memorize noise than learn a real pattern — same spirit as
# learning.py's own MIN_SAMPLES gate for falling back to defaults, just a
# higher bar since a fitted model needs more support than a median does.
MIN_TRAINING_SAMPLES = 15

ROUTE_OPTIONS = ["safe", "fastest", "optimal", "shortest"]
TIME_OF_DAY_BUCKETS = ["morning", "afternoon", "evening", "night"]

# Ratings submitted in under this many seconds are down-weighted during
# training — the exact same "low-effort rating" signal learning.py
# already uses (rating_duration_s), applied here as a sample weight
# instead of a median-input filter. Keeping the same signal, used the
# same way conceptually, across both the heuristic and the ML model.
FAST_SUBMIT_THRESHOLD_S = 3
FAST_SUBMIT_WEIGHT = 0.3

_model_lock = threading.Lock()
_model_cache = {"model": None, "trained_at": None, "n_samples": 0,
                 "feature_importances": None, "feature_names": None}


def _sklearn_available():
    try:
        import sklearn  # noqa: F401
        import joblib   # noqa: F401
        return True
    except ImportError:
        return False


# ─────────────────────────────────────────────
# FEATURE ENGINEERING
# ─────────────────────────────────────────────
def _fetch_training_rows():
    """Pull feedback rows with the fields needed for training. Only rows
    with a usable safety_rating (always required at submission, so this
    is just a defensive NULL check) are used."""
    conn = None
    try:
        conn = get_conn()
        cur = dict_cur(conn)
        cur.execute("""
            SELECT
                safety_rating,
                route_length,
                trip_duration,
                time_of_day,
                route_options,
                rating_duration_s,
                EXTRACT(HOUR FROM submitted_at) AS hour,
                EXTRACT(DOW  FROM submitted_at) AS day_of_week
            FROM user_feedback
            WHERE safety_rating IS NOT NULL
        """)
        return cur.fetchall()
    finally:
        release_conn(conn)


def _row_to_features(row):
    """
    One row -> a fixed-length numeric feature vector:
      [route_length, trip_duration, hour, day_of_week,
       one-hot(time_of_day, 4), one-hot(route_options, 4)]
    Missing route_length/trip_duration are imputed with a sentinel (-1)
    rather than dropped — GradientBoostingRegressor handles that split
    point fine, and it means a row isn't wasted just because one optional
    field wasn't submitted.
    """
    route_length  = row["route_length"]  if row["route_length"]  is not None else -1.0
    trip_duration = row["trip_duration"] if row["trip_duration"] is not None else -1.0
    hour          = float(row["hour"]) if row["hour"] is not None else 12.0
    dow           = float(row["day_of_week"]) if row["day_of_week"] is not None else 3.0

    tod = (row.get("time_of_day") or "").lower()
    tod_onehot = [1.0 if tod == b else 0.0 for b in TIME_OF_DAY_BUCKETS]

    opt = (row.get("route_options") or "").lower()
    # route_options can be a combo string (e.g. "deadend+safety") rather
    # than an exact match to one of the four named modes — substring
    # match against each known option rather than requiring equality.
    opt_onehot = [1.0 if o in opt else 0.0 for o in ROUTE_OPTIONS]

    return [route_length, trip_duration, hour, dow] + tod_onehot + opt_onehot


FEATURE_NAMES = (
    ["route_length_km", "trip_duration_min", "hour", "day_of_week"]
    + [f"tod_{b}" for b in TIME_OF_DAY_BUCKETS]
    + [f"mode_{o}" for o in ROUTE_OPTIONS]
)


def _sample_weight(row):
    secs = row.get("rating_duration_s")
    if secs is not None and secs < FAST_SUBMIT_THRESHOLD_S:
        return FAST_SUBMIT_WEIGHT
    return 1.0


# ─────────────────────────────────────────────
# TRAIN
# ─────────────────────────────────────────────
def train_satisfaction_model():
    """
    Trains (or re-trains) the model from the current contents of
    user_feedback. Returns a status dict — never raises; any failure
    just leaves the previous cached model (if any) in place so a
    training hiccup can't take prediction offline.
    """
    if not _sklearn_available():
        return {"trained": False, "reason": "scikit-learn/joblib not installed"}

    from sklearn.ensemble import GradientBoostingRegressor
    import joblib

    try:
        rows = _fetch_training_rows()
    except Exception as e:
        return {"trained": False, "reason": f"could not read user_feedback: {e}"}

    if len(rows) < MIN_TRAINING_SAMPLES:
        return {
            "trained": False,
            "reason": f"only {len(rows)} feedback rows — need at least {MIN_TRAINING_SAMPLES}",
            "n_samples": len(rows),
        }

    X = np.array([_row_to_features(r) for r in rows], dtype=float)
    y = np.array([float(r["safety_rating"]) for r in rows], dtype=float)
    sample_weight = np.array([_sample_weight(r) for r in rows], dtype=float)

    model = GradientBoostingRegressor(
        n_estimators=100,
        max_depth=3,
        learning_rate=0.1,
        random_state=42,
    )

    try:
        model.fit(X, y, sample_weight=sample_weight)
    except Exception as e:
        return {"trained": False, "reason": f"training failed: {e}"}

    importances = dict(zip(FEATURE_NAMES, model.feature_importances_.round(4).tolist()))

    with _model_lock:
        _model_cache["model"] = model
        _model_cache["trained_at"] = datetime.datetime.utcnow().isoformat()
        _model_cache["n_samples"] = len(rows)
        _model_cache["feature_importances"] = importances
        _model_cache["feature_names"] = FEATURE_NAMES

    try:
        os.makedirs(MODEL_DIR, exist_ok=True)
        joblib.dump(
            {
                "model": model,
                "trained_at": _model_cache["trained_at"],
                "n_samples": len(rows),
                "feature_importances": importances,
            },
            MODEL_PATH,
        )
    except Exception as e:
        # Not fatal — the model is still cached in memory for this
        # process, it just won't survive a restart without retraining.
        print(f"[AI MODEL] could not persist to disk: {e}")

    return {
        "trained": True,
        "n_samples": len(rows),
        "trained_at": _model_cache["trained_at"],
        "feature_importances": importances,
    }


def _load_from_disk_if_needed():
    """Lazily load a previously-trained model from disk on first use in
    a fresh process, so a restart doesn't lose training until the next
    feedback-triggered retrain."""
    if _model_cache["model"] is not None:
        return
    if not _sklearn_available() or not os.path.exists(MODEL_PATH):
        return
    import joblib
    try:
        saved = joblib.load(MODEL_PATH)
        with _model_lock:
            _model_cache["model"] = saved["model"]
            _model_cache["trained_at"] = saved.get("trained_at")
            _model_cache["n_samples"] = saved.get("n_samples", 0)
            _model_cache["feature_importances"] = saved.get("feature_importances")
            _model_cache["feature_names"] = FEATURE_NAMES
    except Exception as e:
        print(f"[AI MODEL] could not load cached model from disk: {e}")


# ─────────────────────────────────────────────
# PREDICT
# ─────────────────────────────────────────────
def predict_satisfaction(route_length=None, trip_duration=None, route_option="safe", hour=None):
    """
    Returns a predicted safety_rating (1.0-5.0, clamped) for a route with
    these characteristics, or None if no trained model is available yet
    — callers (app.py) must treat None as "just omit the AI prediction",
    never as an error.
    """
    _load_from_disk_if_needed()
    model = _model_cache["model"]
    if model is None:
        return None

    now = datetime.datetime.now()
    h = hour if hour is not None else now.hour
    dow = now.weekday()
    tod = "morning" if 5 <= h < 12 else "afternoon" if 12 <= h < 17 else "evening" if 17 <= h < 21 else "night"

    row = {
        "route_length": route_length,
        "trip_duration": trip_duration,
        "time_of_day": tod,
        "route_options": route_option,
        "hour": h,
        "day_of_week": dow,
    }
    X = np.array([_row_to_features(row)], dtype=float)

    try:
        pred = float(model.predict(X)[0])
    except Exception as e:
        print(f"[AI MODEL] prediction failed: {e}")
        return None

    return round(max(1.0, min(5.0, pred)), 2)


def get_model_status():
    _load_from_disk_if_needed()
    trained = _model_cache["model"] is not None
    return {
        "trained": trained,
        "sklearn_available": _sklearn_available(),
        "n_samples": _model_cache["n_samples"],
        "trained_at": _model_cache["trained_at"],
        "feature_importances": _model_cache["feature_importances"],
        "min_samples_required": MIN_TRAINING_SAMPLES,
    }

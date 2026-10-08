import psycopg2
import psycopg2.extras
import psycopg2.extensions
import psycopg2.pool
from dotenv import load_dotenv
import os

load_dotenv()

DB_CONFIG = {
    "dbname":   os.getenv("DB_NAME",     "mew"),
    "user":     os.getenv("DB_USER",     "postgres"),
    "password": os.getenv("DB_PASSWORD", "Chandu@2003"),
    "host":     os.getenv("DB_HOST",     "localhost"),
    "port":     int(os.getenv("DB_PORT", 5432))
}

# Real connection pooling — previously get_conn()/release_conn() opened
# and closed a brand-new TCP connection to Postgres on every single call,
# despite the project write-up describing a ThreadedConnectionPool. Every
# route/feedback/report/news request was paying full connection-setup
# overhead on top of the query itself. This makes that claim actually true.
#
# The pool is created LAZILY (on first get_conn(), not at import time) so
# that a Postgres container that's still starting up — or briefly
# unreachable — doesn't crash the whole app at startup. This matches the
# project's existing "graceful degrade" pattern (e.g. the Learning Module
# falling back to default weights if its query fails) rather than a hard
# crash before any request has even been served.
_pool = None


def _get_pool():
    global _pool
    if _pool is None:
        _pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=int(os.getenv("DB_POOL_MIN", 2)),
            maxconn=int(os.getenv("DB_POOL_MAX", 10)),
            **DB_CONFIG,
        )
    return _pool


def get_conn():
    return _get_pool().getconn()

def release_conn(conn):
    """
    Returns a connection to the pool. Some existing read-only call sites
    (routing.py's SELECT-only paths, learning.py's cache queries) never
    explicitly call commit() on success — harmless when every connection
    was thrown away after use (the old behaviour), but not once
    connections are pooled and reused: a connection returned mid-
    transaction would silently carry that open transaction into whatever
    the NEXT caller does with it. So this always resets to a clean idle
    state before the connection goes back in the pool, and discards
    (rather than reuses) any connection that's broken.
    """
    if conn is None:
        return
    try:
        if conn.closed:
            return
        if conn.get_transaction_status() != psycopg2.extensions.TRANSACTION_STATUS_IDLE:
            conn.rollback()
        _get_pool().putconn(conn)
    except Exception as e:
        print("Error returning connection to pool (discarding it):", e)
        try:
            _get_pool().putconn(conn, close=True)
        except Exception:
            pass

def dict_cur(conn):
    return conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
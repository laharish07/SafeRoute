// SafeRoute mobile — single map-first screen (see screens/HomeScreen.jsx).
import React from "react";
import { View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useFonts } from "expo-font";
import { Syne_700Bold, Syne_800ExtraBold } from "@expo-google-fonts/syne";
import { DMSans_400Regular, DMSans_500Medium, DMSans_600SemiBold } from "@expo-google-fonts/dm-sans";
import { DMMono_400Regular, DMMono_500Medium } from "@expo-google-fonts/dm-mono";
import HomeScreen from "./screens/HomeScreen";

export default function App() {
  const [loaded, error] = useFonts({
    Syne_700Bold, Syne_800ExtraBold,
    DMSans_400Regular, DMSans_500Medium, DMSans_600SemiBold,
    DMMono_400Regular, DMMono_500Medium,
  });
  if (!loaded && !error) return <View style={{ flex: 1, backgroundColor: "#0d1117" }} />;
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <HomeScreen />
    </SafeAreaProvider>
  );
}

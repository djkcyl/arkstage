import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import HomePage from "./pages/HomePage";
import StoryBrowserPage from "./pages/StoryBrowserPage";
import StoryPlayerPage from "./pages/StoryPlayerPage";
import SettingsPage from "./pages/SettingsPage";
import DebugConsole from "./components/DebugConsole";
import { installAndroidBack } from "./lib/androidBack";

export default function App() {
  useEffect(() => installAndroidBack(), []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/browse" element={<StoryBrowserPage />} />
        <Route path="/play/:pageTitle" element={<StoryPlayerPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
      <DebugConsole />
    </BrowserRouter>
  );
}

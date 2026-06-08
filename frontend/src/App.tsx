import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import HomePage from "./pages/HomePage";
import StoryBrowserPage from "./pages/StoryBrowserPage";
import StoryPlayerPage from "./pages/StoryPlayerPage";
import SettingsPage from "./pages/SettingsPage";
import DebugConsole from "./components/DebugConsole";
import { applyPersistedDownloadSettings } from "./lib/predownload";

export default function App() {
  // Re-apply the user's saved concurrency / bandwidth limit to the backend once
  // on startup (the backend keeps them in memory only).
  useEffect(() => {
    applyPersistedDownloadSettings();
  }, []);

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

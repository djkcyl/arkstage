import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import HomePage from "./pages/HomePage";
import StoryBrowserPage from "./pages/StoryBrowserPage";
import StoryPlayerPage from "./pages/StoryPlayerPage";
import SettingsPage from "./pages/SettingsPage";
import AboutPage from "./pages/AboutPage";
import HelpPage from "./pages/HelpPage";
import DebugConsole from "./components/DebugConsole";
import DownloadBar from "./components/DownloadBar";
import { DownloadProvider } from "./lib/DownloadContext";
import { CompressionProvider } from "./lib/CompressionContext";
import { applyPersistedDownloadSettings } from "./lib/predownload";
import { startKeepalive } from "./lib/keepalive";

export default function App() {
  // Re-apply the user's saved concurrency / bandwidth limit to the backend once
  // on startup (the backend keeps them in memory only).
  useEffect(() => {
    applyPersistedDownloadSettings();
    // Android: set the keep-alive notification to its idle text. The foreground
    // service itself is started natively at launch (MainActivity); this just gives
    // it content. No-op on desktop.
    startKeepalive();
  }, []);

  return (
    <BrowserRouter>
      <CompressionProvider>
      <DownloadProvider>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/browse" element={<StoryBrowserPage />} />
          <Route path="/play/:pageTitle" element={<StoryPlayerPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/help" element={<HelpPage />} />
        </Routes>
        {/* High-priority, app-wide download progress (hidden inside the reader). */}
        <DownloadBar />
        <DebugConsole />
      </DownloadProvider>
      </CompressionProvider>
    </BrowserRouter>
  );
}

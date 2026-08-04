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
import { applyPersistedDownloadSettings, loadBundle } from "./lib/predownload";
import { startKeepalive } from "./lib/keepalive";
import { BookshelfMetadataProvider } from "./lib/BookshelfMetadataContext";
import ManifestProbePage from "./pages/ManifestProbePage";

export default function App() {
  // Re-apply the user's saved concurrency / bandwidth limit to the backend once
  // on startup (the backend keeps them in memory only).
  useEffect(() => {
    applyPersistedDownloadSettings();
    // Start the validated ScenarioSimulator/data-table hot update immediately;
    // playback still has an exact-page fresh-first check before it boots.
    void loadBundle().catch((error) => console.warn("PRTS engine startup sync failed", error));
    // Android: set the keep-alive notification to its idle text. The foreground
    // service itself is started natively at launch (MainActivity); this just gives
    // it content. No-op on desktop.
    startKeepalive();
  }, []);

  const manifestProbeTitles = import.meta.env.DEV
    ? new URLSearchParams(window.location.search).getAll("manifestProbe")
    : [];
  if (manifestProbeTitles.length > 0) {
    return <ManifestProbePage titles={manifestProbeTitles} />;
  }

  return (
    <BrowserRouter>
      <BookshelfMetadataProvider>
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
      </BookshelfMetadataProvider>
    </BrowserRouter>
  );
}

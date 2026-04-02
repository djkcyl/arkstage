import { BrowserRouter, Routes, Route } from "react-router-dom";
import HomePage from "./pages/HomePage";
import StoryBrowserPage from "./pages/StoryBrowserPage";
import StoryPlayerPage from "./pages/StoryPlayerPage";
import SettingsPage from "./pages/SettingsPage";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/browse" element={<StoryBrowserPage />} />
        <Route path="/play/:pageTitle" element={<StoryPlayerPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </BrowserRouter>
  );
}

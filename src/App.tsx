import { BrowserRouter, Navigate, Route, Routes, StaticRouter } from "react-router-dom";
import StopPage from "./StopPage";
import UnhappyPage from "./UnhappyPage";
import { DEFAULT_STOP_CODE } from "./stopConfig";
import type { InitialStopData } from "./initialStopData";

interface AppProps {
  initialStopData?: InitialStopData | null;
  location?: string;
}

function AppRoutes({ initialStopData }: { initialStopData?: InitialStopData | null }) {
  return (
    <Routes>
      <Route path="/" element={<Navigate to={`/stop/${DEFAULT_STOP_CODE}`} replace />} />
      <Route path="/unhappy" element={<UnhappyPage />} />
      <Route
        path="/stop/:stopCode"
        element={<StopPage initialData={initialStopData ?? null} />}
      />
    </Routes>
  );
}

export default function App({ initialStopData = null, location }: AppProps) {
  if (location) {
    return (
      <StaticRouter location={location}>
        <AppRoutes initialStopData={initialStopData} />
      </StaticRouter>
    );
  }

  return (
    <BrowserRouter>
      <AppRoutes initialStopData={initialStopData} />
    </BrowserRouter>
  );
}

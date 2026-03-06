import { renderToString } from "react-dom/server";
import App from "./App";
import type { InitialStopData } from "./initialStopData";

export function render(url: string, initialStopData: InitialStopData | null): string {
  return renderToString(<App location={url} initialStopData={initialStopData} />);
}

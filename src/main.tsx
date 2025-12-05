/// @notice Imports StrictMode to enforce best practices during development.
import { StrictMode } from "react";
/// @notice Imports the modern React root creation helper for concurrent rendering.
import { createRoot } from "react-dom/client";
/// @notice Brings the global application styles into the bundle.
import "./index.css";
/// @notice Imports the root App component that houses the experience.
import App from "./App.tsx";
/// @notice Imports the MoonPayProvider to share MoonPay context throughout the tree.
import { MoonPayProvider } from "@moonpay/moonpay-react";

/// @notice Reads the MoonPay publishable key from the Vite environment.
const moonPayApiKey = import.meta.env.VITE_MOONPAY_API_KEY;

/// @notice Guards the render pipeline if the API key is not present.
if (!moonPayApiKey) {
  /// @notice Throws early so developers configure the environment properly.
  throw new Error(
    "Missing VITE_MOONPAY_API_KEY. Add it to your .env.local file."
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MoonPayProvider apiKey={moonPayApiKey} debug>
      <App />
    </MoonPayProvider>
  </StrictMode>
);

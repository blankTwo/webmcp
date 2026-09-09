import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import FloatBall from "./FloatBall";
import "./index.css";
import "./console-dashboard.css";

const isFloatBallWindow = window.location.search.includes("window=float-ball");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isFloatBallWindow ? <FloatBall /> : <App />}
  </React.StrictMode>,
);

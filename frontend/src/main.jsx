import React from "react"
import { createRoot } from "react-dom/client"
import "@fontsource-variable/inter"
import "@fontsource-variable/oswald"
import App from "./App.jsx"
import "./global.css"

createRoot(document.getElementById("root")).render(<App />)

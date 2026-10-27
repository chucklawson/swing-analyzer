import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import SplashPage from './SplashPage.tsx'
import CreateVideos from './CreateVideos.tsx'
import { Amplify } from "aws-amplify";
import outputs from "../amplify_outputs.json";
Amplify.configure(outputs);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<SplashPage />} />
        <Route path="/analyzer" element={<App />} />
        <Route path="/create-videos" element={<CreateVideos />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)

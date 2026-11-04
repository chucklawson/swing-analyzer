import { useNavigate } from 'react-router-dom'
import deersAtFlag from './assets/deersAtFlag.jpeg'

export default function SplashPage() {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen flex flex-col items-center justify-center relative overflow-hidden select-none"
      style={{ backgroundImage: `url(${deersAtFlag})`, backgroundSize: 'cover', backgroundPosition: 'center' }}>

      <style>{`
        @keyframes flip3d {
          0%   { transform: rotateY(0deg); }
          100% { transform: rotateY(360deg); }
        }
        .title-flip {
          display: inline-block;
          animation: flip3d 10s linear infinite;
        }
      `}</style>

      {/* dark overlay over photo */}
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'rgba(0,0,0,0.62)' }} />

      {/* background radial glow */}
      <div className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse 70% 50% at 50% 40%, rgba(34,197,94,0.08) 0%, transparent 70%)' }} />

      {/* decorative arc lines */}
      <svg className="absolute inset-0 w-full h-full opacity-10 pointer-events-none" aria-hidden="true">
        <ellipse cx="50%" cy="110%" rx="45%" ry="55%" fill="none" stroke="#22c55e" strokeWidth="1" />
        <ellipse cx="50%" cy="110%" rx="35%" ry="42%" fill="none" stroke="#22c55e" strokeWidth="0.5" />
        <ellipse cx="50%" cy="110%" rx="25%" ry="30%" fill="none" stroke="#22c55e" strokeWidth="0.5" />
      </svg>

      {/* logo / title */}
      <div className="relative flex flex-col items-center gap-3 mb-12">
        <div style={{ perspective: '600px' }}>
          <h1 className="title-flip text-6xl font-black tracking-tight leading-none">
            <span className="text-white">Build an </span><span className="text-green-400">Oily Swing</span>
          </h1>
        </div>

      </div>

      {/* tagline */}
      <p className="text-gray-500 text-sm mb-14 text-center max-w-xs leading-relaxed">
        Two-camera slow-motion pose analysis.<br />See your angles. Fix your swing.
      </p>

      {/* CTA buttons */}
      <div className="flex flex-col items-center gap-4">
        <button
          onClick={() => navigate('/analyzer')}
          className="px-10 py-4 rounded-xl text-lg font-semibold text-gray-900 bg-white hover:bg-gray-100 active:scale-95 transition-all duration-150 shadow-lg shadow-black/40 cursor-pointer w-64"
        >
          Analyze My Swing →
        </button>
        <button
          onClick={() => navigate('/create-videos')}
          className="px-10 py-4 rounded-xl text-lg font-semibold text-white border-2 border-white hover:bg-white hover:text-gray-900 active:scale-95 transition-all duration-150 cursor-pointer w-64"
        >
          Create Videos →
        </button>
      </div>

      <p className="absolute bottom-6 text-gray-400 text-xs tracking-wider">
        OILY SWING © {new Date().getFullYear()}
      </p>
    </div>
  )
}
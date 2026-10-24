import { useNavigate } from 'react-router-dom'

export default function SplashPage() {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center relative overflow-hidden select-none">

      <style>{`
        @keyframes flip3d {
          0%   { transform: rotateY(0deg); }
          100% { transform: rotateY(360deg); }
        }
        .title-flip {
          display: inline-block;
          animation: flip3d 4s linear infinite;
        }
      `}</style>

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
        {/* golf ball icon */}
        <div className="w-16 h-16 rounded-full mb-2 flex items-center justify-center"
          style={{ background: 'radial-gradient(circle at 38% 35%, #f0f0f0, #b0b0b0)', boxShadow: '0 4px 24px rgba(0,0,0,0.6)' }}>
          <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
            {[
              [22,14],[14,19],[30,19],[10,26],[22,24],[34,26],[16,32],[28,32]
            ].map(([cx,cy], i) => (
              <circle key={i} cx={cx} cy={cy} r="2.2" fill="rgba(0,0,0,0.18)" />
            ))}
          </svg>
        </div>

        <div style={{ perspective: '600px' }}>
          <h1 className="title-flip text-6xl font-black tracking-tight leading-none">
            <span className="text-white">Build an </span><span className="text-green-400">Oily Swing</span>
          </h1>
        </div>

        <p className="text-gray-400 text-lg tracking-widest uppercase font-light">
          Swing Analyzer
        </p>
      </div>

      {/* tagline */}
      <p className="text-gray-500 text-sm mb-14 text-center max-w-xs leading-relaxed">
        Two-camera slow-motion pose analysis.<br />See your angles. Fix your swing.
      </p>

      {/* CTA */}
      <button
        onClick={() => navigate('/analyzer')}
        className="px-10 py-4 rounded-xl text-lg font-semibold text-black bg-green-400 hover:bg-green-300 active:scale-95 transition-all duration-150 shadow-lg shadow-green-900/40 cursor-pointer"
      >
        Analyze My Swing →
      </button>

      <p className="absolute bottom-6 text-gray-700 text-xs tracking-wider">
        OILY SWING © {new Date().getFullYear()}
      </p>
    </div>
  )
}
import React, { useState } from 'react';
import { loginUser, registerUser } from '../services/auth';
import { User } from '../types';
import { LogIn, UserPlus, Loader2, AlertCircle } from 'lucide-react';

interface AuthProps {
  onLogin: (user: User) => void;
}

export const Auth: React.FC<AuthProps> = ({ onLogin }) => {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const user = isLogin 
        ? await loginUser(email, password)
        : await registerUser(email, password);
      onLogin(user);
    } catch (err: any) {
      setError(err.message || "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden">
      <div className="bg-slate-50 p-6 text-center border-b border-slate-100">
        <h2 className="text-2xl font-bold text-slate-800">
          {isLogin ? 'Welcome Back' : 'Create Account'}
        </h2>
        <p className="text-slate-500 text-sm mt-1">
          {isLogin ? 'Login to manage your files' : 'Register to unlock features'}
        </p>
      </div>

      <div className="p-8">
        {error && (
          <div className="bg-red-50 text-red-600 p-3 rounded-lg text-sm flex items-center gap-2 mb-6">
            <AlertCircle size={16} />
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Email Address</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition-all"
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none transition-all"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brand-600 text-white font-bold py-3 rounded-lg hover:bg-brand-700 transition-all duration-200 shadow-lg shadow-brand-600/25 hover:shadow-xl hover:shadow-brand-600/30 hover:-translate-y-0.5 flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 size={20} className="animate-spin" />
            ) : isLogin ? (
              <><LogIn size={20} /> Login</>
            ) : (
              <><UserPlus size={20} /> Register</>
            )}
          </button>
        </form>

        <div className="mt-6 text-center">
          <button
            onClick={() => { setIsLogin(!isLogin); setError(''); }}
            className="text-brand-600 text-sm font-medium hover:underline"
          >
            {isLogin ? "Don't have an account? Register" : "Already have an account? Login"}
          </button>
        </div>
      </div>
    </div>
  );
};
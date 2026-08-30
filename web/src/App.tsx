import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import Home from './pages/Home';
import Browse from './pages/Browse';
import Library from './pages/Library';
import TitleDetail from './pages/TitleDetail';
import Reader from './pages/Reader';

export default function App() {
  const [dark, setDark] = useState(() => localStorage.getItem('theme') !== 'light');

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <NavLink to="/" className="brand">
            📚 Manga App
          </NavLink>
          <nav className="nav">
            <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
              Home
            </NavLink>
            <NavLink to="/browse" className={({ isActive }) => (isActive ? 'active' : '')}>
              Browse
            </NavLink>
            <NavLink to="/library" className={({ isActive }) => (isActive ? 'active' : '')}>
              Library
            </NavLink>
          </nav>
          <button className="theme-toggle" onClick={() => setDark((d) => !d)} title="Toggle theme">
            {dark ? '☀️' : '🌙'}
          </button>
        </div>
      </header>

      <main className="content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/browse" element={<Browse />} />
          <Route path="/library" element={<Library />} />
          <Route path="/library/:id" element={<TitleDetail />} />
          <Route path="/library/:id/read/:chapterId" element={<Reader />} />
        </Routes>
      </main>

      <footer className="footer">
        Content is served from{' '}
        <a href="https://mangadex.org" target="_blank" rel="noreferrer">
          MangaDex
        </a>{' '}
        and other configured sources — fan translations and scanlation groups are credited per
        chapter. This is a non-commercial, ad-free personal library app.
      </footer>
    </div>
  );
}
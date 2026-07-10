"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Bell, ChevronDown, History, ListChecks, LogOut, Moon, Puzzle, Settings, SlidersHorizontal, Sun, Upload, Youtube } from "lucide-react";

const THEME_STORAGE_KEY = "youtube-ab-tests-theme";

export default function AppShell({ session, active, children }) {
  const [theme, setTheme] = useState("dark");
  const primaryNav = [
    { href: "/", label: "Detector", key: "detector", icon: Youtube },
    { href: "/review", label: "Review", key: "review", icon: ListChecks },
    { href: "/history", label: "History", key: "history", icon: History }
  ];
  const manageNav = [
    { href: "/uploads", label: "Uploads", key: "uploads", icon: Upload },
    { href: "/extension", label: "Extension", key: "extension", icon: Puzzle },
    { href: "/notifications", label: "Notifications", key: "notifications", icon: Bell },
    { href: "/settings", label: "Settings", key: "settings", icon: Settings }
  ];
  const ThemeIcon = theme === "dark" ? Sun : Moon;

  useEffect(() => {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    const initial = saved === "light" || saved === "dark" ? saved : systemTheme();
    applyTheme(initial);
    setTheme(initial);
  }, []);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    applyTheme(next);
    setTheme(next);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <Image
            className="brand-logo"
            src="/icon-192.png"
            alt="YouTube A/B Tests"
            width={58}
            height={58}
            priority
          />
          <div>
            <p className="eyebrow">YouTube A/B Tests</p>
            <h1>Test Finish Detector</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <button
            className="icon-button"
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            onClick={toggleTheme}
          >
            <ThemeIcon size={18} />
          </button>
          <button
            className="icon-button"
            title="Enable browser notifications"
            onClick={() => {
              if ("Notification" in window) Notification.requestPermission();
            }}
          >
            <Bell size={18} />
          </button>
          <button
            className="icon-button"
            title="Switch reviewer"
            aria-label="Switch reviewer"
            onClick={async () => {
              await fetch("/api/access/logout", { method: "POST" }).catch(() => null);
              window.location.href = "/login";
            }}
          >
            <LogOut size={18} />
          </button>
          <span className="user-chip">{session?.actorName || "Reviewer"}</span>
        </div>
      </header>
      <nav className="nav-tabs primary-nav-tabs">
        {primaryNav.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              className={active === item.key ? "nav-tab active" : "nav-tab"}
              href={item.href}
              key={item.key}
            >
              <Icon size={16} />
              {item.label}
            </Link>
          );
        })}
        <details className={`manage-nav ${manageNav.some((item) => item.key === active) ? "active" : ""}`}>
          <summary className="nav-tab">
            <SlidersHorizontal size={16} />
            Manage
            <ChevronDown size={14} />
          </summary>
          <div className="manage-nav-menu">
            {manageNav.map((item) => {
              const Icon = item.icon;
              return (
                <Link className={active === item.key ? "manage-nav-item active" : "manage-nav-item"} href={item.href} key={item.key}>
                  <Icon size={16} />
                  <span><strong>{item.label}</strong><small>{manageDescription(item.key)}</small></span>
                </Link>
              );
            })}
          </div>
        </details>
      </nav>
      {children}
    </div>
  );
}

function manageDescription(key) {
  if (key === "uploads") return "Thumbnail workbooks";
  if (key === "extension") return "Studio detection";
  if (key === "notifications") return "Team alerts";
  return "Data sources and admin";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

function systemTheme() {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

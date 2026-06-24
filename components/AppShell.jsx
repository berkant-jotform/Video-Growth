"use client";

import Link from "next/link";
import { Bell, History, Settings, Upload, Youtube } from "lucide-react";

export default function AppShell({ session, active, children }) {
  const nav = [
    { href: "/", label: "Detector", key: "detector", icon: Youtube },
    { href: "/history", label: "History", key: "history", icon: History },
    { href: "/uploads", label: "Uploads", key: "uploads", icon: Upload },
    { href: "/settings", label: "Settings", key: "settings", icon: Settings }
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">YouTube A/B Tests</p>
          <h1>Test Finish Detector</h1>
        </div>
        <div className="topbar-actions">
          <button
            className="icon-button"
            title="Enable browser notifications"
            onClick={() => {
              if ("Notification" in window) Notification.requestPermission();
            }}
          >
            <Bell size={18} />
          </button>
          <span className="user-chip">{session?.actorName || "Reviewer"}</span>
        </div>
      </header>
      <nav className="nav-tabs">
        {nav.map((item) => {
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
      </nav>
      {children}
    </div>
  );
}

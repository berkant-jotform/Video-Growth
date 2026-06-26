import "./globals.css";

export const metadata = {
  title: "YouTube A/B Tests",
  description: "Cloud test finish detector for YouTube A/B tests",
  manifest: "/site.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-64.png", sizes: "64x64", type: "image/png" }
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]
  },
  appleWebApp: {
    title: "YouTube A/B Tests",
    capable: true,
    statusBarStyle: "black-translucent"
  }
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function () {
                try {
                  var saved = localStorage.getItem("youtube-ab-tests-theme");
                  var theme = saved === "light" || saved === "dark"
                    ? saved
                    : (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
                  document.documentElement.dataset.theme = theme;
                } catch (error) {}
              })();
            `
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}

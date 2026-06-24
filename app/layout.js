import "./globals.css";

export const metadata = {
  title: "YouTube A/B Tests",
  description: "Cloud test finish detector for YouTube A/B tests"
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

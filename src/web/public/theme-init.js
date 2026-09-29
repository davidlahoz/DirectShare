// Applies a saved theme before the page renders to avoid a flash of the wrong colors.
// Kept as an external file because the Content-Security-Policy forbids inline scripts.
try {
  var theme = localStorage.getItem('directsend-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch (e) {
  /* storage unavailable: follow the system setting */
}

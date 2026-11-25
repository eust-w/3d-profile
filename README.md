# eust-w 3D profile

Static site (three.js, no build step). Files: `index.html`, `style.css`, `main.js`, `vendor/three.module.min.js`.

- Preview: `python3 -m http.server 5188` → http://localhost:5188
- Deploy: push to a repo with GitHub Pages enabled (or any static host), point `longtao.fun` at it.
- `?p=2.2` pins the scene stage (0 hero · 1 embodied · 2 real2sim · 3 ai4ai · 4 work) for screenshots.
- `profile-readme/` is the content for the special `eust-w/eust-w` profile repo README.
- Star counts update live from the GitHub API; static fallbacks live in `main.js` (`PROJECTS`).

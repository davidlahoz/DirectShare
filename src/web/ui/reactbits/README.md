# React Bits components

Adapted from [React Bits](https://reactbits.dev) (MIT + Commons Clause) by David Haz.
Sources fetched from the React Bits registry (`https://reactbits.dev/r/<Name>-TS-CSS.json`).

Changes made for DirectShare:

- Colors come from the app's color tokens instead of hard-coded values.
- Every animation honors `prefers-reduced-motion`.
- Continuous animation loops stop when idle or when the tab is hidden, so they never compete with file transfers for CPU.
- Styles live in `src/web/ui/styles.css`. No component injects `<style>` or inline scripts, which the Content-Security-Policy would block.

| Component | Used for |
| --- | --- |
| BlurText | Headline reveal |
| ShinyText | Eyebrow pill and waiting messages |
| SpotlightCard | Dropzone, feature tiles, save options |
| CountUp | Download statistics |
| ClickSpark | Feedback on primary actions |
| StarBorder | Primary call-to-action buttons |

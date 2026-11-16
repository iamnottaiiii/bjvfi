# Remote Browser

A real Chrome running in the cloud (GitHub Codespaces), streamed into a tab in
any browser. Open the link and you get a full desktop browser: tabs, address
bar, the works. It runs on GitHub's machines, so it works from anywhere.

## Use it

1. Open https://codespaces.new/iamnottaiiii/bjvfi
2. If GitHub asks which configuration, pick **Remote Browser**. First build
   takes a few minutes.
3. When the Codespace starts, the terminal prints **YOUR REMOTE BROWSER
   LINK**. The same link is saved in `remote-browser/LINK.txt`.
4. Open that link in any browser. That tab is now the remote browser.

## Notes

- The Codespace stops itself after about 30 idle minutes. Restart it from
  https://github.com/codespaces and the browser comes back with its tabs and
  logins intact (the Chrome profile lives in this folder inside the
  Codespace).
- Free GitHub accounts include 120 core-hours of Codespaces per month, about
  60 hours of this 2-core browser.
- The VNC password is generated on first start inside the Codespace and
  stored in `remote-browser/vnc-pass.txt` there. The link already carries it.
- If the link asks for a GitHub sign-in, that is the port set to Private. In
  the Codespace's Ports tab, set port 6080 to Public and the link opens
  directly.

## How it works

Xvfb makes a virtual screen, Chrome runs on it, x11vnc shares the screen, and
noVNC turns that into a web page on port 6080. Codespaces forwards the port
as the public link. The Codespaces configuration lives in
`.devcontainer/remote-browser/` because that is the only place GitHub scans
for it; everything else about the browser lives in this folder.

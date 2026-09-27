# Orbit Spaces — GitHub Pages edition

A Dark Liquid Glass website organizer that runs entirely on GitHub Pages. Visitors can create Spaces, save/edit/remove website links, open sites in new browser tabs, and export/import a JSON backup.

## Publish on GitHub Pages

1. Extract the ZIP. Open the `orbit-spaces-pages` folder.
2. Create a new **public repository** on GitHub. Upload the **contents of that folder** to the repository root (`index.html`, `styles.css`, `script.js`, `assets/`, etc.), not the folder itself.
3. In the repository, open **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**, then select the `main` branch and `/ (root)`. Save.
5. When GitHub finishes publishing, open the URL shown on the Pages settings screen. A project repository usually gets `https://YOUR-USERNAME.github.io/REPOSITORY-NAME/`.

No `npm install`, build command, server, or account service is needed. The app uses relative asset URLs, so it works in a project repository subpath. It also works when opened from a local static server.

## How it works

- **Spaces** are collections of saved websites. Make separate collections for different topics or purposes.
- **Open** a card to launch the website in a normal browser tab. The search/address bar opens a website or searches Google in a new tab.
- **Export** downloads your current Spaces and links as JSON. **Import** replaces current local data with a backup after confirmation.
- Data lives in that visitor's **browser local storage** for the Pages site's origin. It does **not** sync between devices, different browsers, or visitors. Clearing browser site data can remove it. Keep backups if the links matter to you.

**Important sign-in limitation:** This edition does **not** isolate website accounts. Spaces organize links only; all sites use normal browser cookies and logins. GitHub Pages cannot run the persistent browser service that separate sign-ins would require. Removing a saved link or deleting a Space does not sign out of a website or clear that site's cookies. Some sites may block embedding, so links open in normal tabs rather than in an in-app frame.

## Privacy and safety

There is no app account or backend. The app does not ask for website passwords. Its saved link data remains in local browser storage unless you export a backup; imported files are parsed locally. Opened websites handle their own sign-ins and data. Only `http` and `https` links can be saved/opened, and saved links open with `noopener noreferrer`.

## Files

- `index.html` — interface
- `styles.css` — dark glass layout
- `script.js` — local data and interactions
- `assets/images/orbit.png` — decorative artwork
- `.nojekyll` — publish static files as-is

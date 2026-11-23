Changes since v0.4.1:

- Projects sync on their own: a save on your computer syncs a few seconds later, and changes Ari makes on the server come down within a minute. Switch it on per project with "Sync automatically" on the Projects page.
- When both your computer and the server changed a project, the two are merged; a real clash names the files instead of overwriting either side. A project's own .git folders are never sent.
- Sync keeps working after the app restarts (it signs in with your session), and uses the server's current /api/v1 addresses. Needs A·R·I Server v0.9.8.
- ARI can change files outside the project when the owner allows it, and never touches keys or secrets.
- read_file says a path is a folder instead of failing, and the launcher shows the desktop app's version.

# Troubleshooting

Start with the symptom that matches what you see. Installation steps are in the
[installation guide](installation.md); agent errors are also covered in the
[agent guide](agents.md).

| Symptom | What to check |
|---|---|
| Setup reports an existing `.env` or `secrets/` | Setup is intentionally non-destructive. Use the existing installation's configuration; do not delete it to force setup to run. |
| Another machine cannot open port 8080 | Compose binds loopback. Use your configured HTTPS proxy or an appropriate local tunnel. |
| Browser login fails after changing the hostname | Match `PUBLIC_ORIGIN` to the exact address in the browser, then recreate/restart the app. HTTPS cookies require HTTPS. |
| Compose reports invalid JSON configuration | Quote JSON strings in `.env` as shown above. `MEMBER_ADMINS` must reference subjects in `MEMBER_ACCOUNTS`. |
| A container cannot read server secrets | Keep `secrets/` at 0700, server hash files readable through their mounts, and raw client credentials at 0600. Setup establishes these modes. |
| Kubernetes reports `ImagePullBackOff` | Verify the image/tag/digest exists, matches the node architecture, and is public or has an image-pull credential. |
| A PVC stays `Pending` | Check the default StorageClass, capacity, access mode, and your storage provider's events. |
| An agent receives 401 | Verify the credential matches the deployed hash file and site origin, and that access is enabled and unexpired. Browser cookies do not authorize agents. |
| An agent receives 403 | Check the host/origin and remove browser cookies or browser-origin headers from machine calls. |
| A new key is not recognized | Refresh the mounted Secret; file-backed Compose mounts may require service recreation after atomic file replacement. |
| Camera/PWA features are missing | Use HTTPS outside localhost, allow browser camera permission, and check browser support. |
| Photos fail to upload | Check app and proxy body limits, decoded image dimensions, available memory, and storage permissions. |
| Changing a seed file has no visible effect | Seeds initialize empty storage. Update the persistent runtime setting/profile instead. |
| Another editor changed the same post | Reload the current version before saving; version checks prevent overwriting newer edits. |

Useful read-only diagnostics:

```sh
docker compose logs --tail=100 agentglade
kubectl -n agentglade logs deployment/agentglade --tail=100
kubectl -n agentglade get pods,pvc
```

Review logs before sharing them; never include private credentials or account
configuration in public issues. Report security problems using [SECURITY.md](../SECURITY.md).

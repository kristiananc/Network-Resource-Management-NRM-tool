# Cloudflare Tunnel for the NRM Local API (Windows)

This runbook publishes the FastAPI service running on the same Windows server
as Ollama through a remotely managed Cloudflare Tunnel. Cloudflare Access
requires a service token at the edge, and FastAPI continues to require its
independent `NRM_INTERNAL_API_TOKEN` bearer token.

## Domain requirement and free options

A stable production published application requires an active domain in the
Cloudflare account. Use a hostname such as `nrm-api.example.com` on that domain.
The domain may be registered through Cloudflare Registrar or registered
elsewhere and delegated to Cloudflare DNS.

Cloudflare Quick Tunnels do not require an account or domain:

```powershell
cloudflared tunnel --url http://localhost:8000
```

That command creates a random `*.trycloudflare.com` URL. Quick Tunnel URLs
change when the process restarts, have no uptime guarantee, and are intended
only for development and testing. They are not the NRM production path and do
not provide the stable, account-managed hostname needed for this Access setup.

## Values to choose or generate

Replace these placeholders throughout the procedure:

- `<NRM_HOSTNAME>`: for example, `nrm-api.example.com`.
- `<TUNNEL_TOKEN>`: the secret token displayed by the Tunnel setup page.
- `<ACCESS_CLIENT_ID>` and `<ACCESS_CLIENT_SECRET>`: the Access service-token
  values. Cloudflare displays the Client Secret only once.
- `<NRM_INTERNAL_API_TOKEN>`: the existing FastAPI bearer token. This must be
  the same value configured in the FastAPI process environment.

Never commit any of these secret values. The public hostname is not a secret.

## 1. Verify FastAPI locally on the Windows server

Run FastAPI on loopback because `cloudflared` is on the same machine:

```powershell
cd C:\path\to\Network-Resource-Management-NRM-tool
$env:NRM_INTERNAL_API_TOKEN = '<NRM_INTERNAL_API_TOKEN>'
$env:PYTHONPATH = 'local-api'
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

In a second PowerShell window, verify the authenticated health endpoint:

```powershell
$headers = @{ Authorization = "Bearer $env:NRM_INTERNAL_API_TOKEN" }
Invoke-RestMethod -Uri 'http://127.0.0.1:8000/health' -Headers $headers
```

Expected fields include `status: ok`, `service: nrm-local-api`, and
`schema_version: 1.0`. If FastAPI is intentionally bound only to
`192.168.0.200`, either change it to loopback/`0.0.0.0` or use
`http://192.168.0.200:8000` as the Tunnel Service URL. Loopback is preferred
because it avoids exposing port 8000 to the LAN.

The Tunnel service keeps `cloudflared` alive, not FastAPI. Keep the existing
headless FastAPI startup mechanism enabled separately.

## 2. Put a domain on Cloudflare if needed

Skip this section if the account already has an active domain suitable for the
hostname.

1. In the Cloudflare dashboard, add an existing registered domain under
   **Websites** and follow the nameserver-change instructions, or register a
   domain through Cloudflare Registrar.
2. Wait until the zone is **Active**.
3. Choose a single-label subdomain such as `nrm-api.example.com`.

Do not use a multi-level name such as `api.nrm.example.com` unless its TLS
certificate requirements have been reviewed; a single-label subdomain works
with the normal Universal SSL coverage.

## 3. Create the Access service token

1. Open **Zero Trust > Access controls > Service credentials > Service
   Tokens**.
2. Select **Create Service Token**.
3. Name it `nrm-apps-script` and select an expiration appropriate for the
   deployment's rotation policy.
4. Generate it and immediately store both the Client ID and Client Secret in a
   password manager. The Client Secret is shown only once.

## 4. Create the Access application before publishing the Tunnel route

Creating Access first avoids an interval where the hostname is publicly
reachable without edge authentication.

1. Open **Zero Trust > Access controls > Applications**.
2. Select **Create new application**, then **Self-hosted and private**.
3. Select **Add public hostname** and enter `<NRM_HOSTNAME>` using the active
   Cloudflare zone.
4. Name the application `NRM Local API`.
5. Add exactly this machine policy:
   - Action: **Service Auth**
   - Include selector: **Service Token**
   - Value: `nrm-apps-script`
6. Do not add an **Allow Everyone** or **Bypass** policy.
7. Enable **401 Response for Service Auth policies** if the dashboard presents
   that option; this makes missing/invalid machine credentials fail with HTTP
   401 rather than an interactive login page.
8. Save the application.

## 5. Create and install the remotely managed Tunnel

1. In the Cloudflare dashboard, open **Networking > Tunnels**.
2. Select **Create Tunnel** and name it `nrm-local-api`.
3. Under **Setup Environment**, select Windows and the server's architecture
   (normally 64-bit).
4. Download and install the current Windows MSI or executable from Cloudflare's
   `cloudflared` downloads page. Windows installations do not auto-update, so
   plan to update the binary periodically.
5. Open **Command Prompt as Administrator** and verify the installation:

   ```bat
   cloudflared.exe --version
   ```

6. Copy the Windows install command generated by the dashboard. Its canonical
   form is:

   ```bat
   cloudflared.exe service install <TUNNEL_TOKEN>
   ```

   Treat the token as a secret. Use the dashboard's generated value; do not
   paste it into this repository or logs.
7. Wait for the dashboard to show the connector and Tunnel as **Healthy**.

The service-install command registers `cloudflared` as a Windows service, so it
starts at boot and does not depend on an interactive user session. Useful
checks from an elevated Command Prompt are:

```bat
sc query cloudflared
sc start cloudflared
sc stop cloudflared
```

If the connector cannot become healthy, allow outbound and return traffic on
port `7844` over TCP and UDP. Cloudflare Tunnel is outbound-only; do not open an
inbound router or Windows Firewall port for FastAPI.

## 6. Publish the FastAPI route

1. Open **Networking > Tunnels > nrm-local-api**.
2. Under **Routes**, select **Add route**, then **Published application**.
3. Set **Hostname** to `<NRM_HOSTNAME>`.
4. Set **Service URL** to:

   ```text
   http://localhost:8000
   ```

5. Enable **Protect with Access** if that option is present and select/confirm
   the `NRM Local API` Access application.
6. Save the route. Cloudflare creates the proxied DNS record pointing the
   hostname to the Tunnel.

## 7. Verify both authentication layers

From a machine outside the Windows server, first confirm Access rejects a
request that has only the FastAPI bearer token:

```powershell
$apiHeaders = @{ Authorization = 'Bearer <NRM_INTERNAL_API_TOKEN>' }
Invoke-WebRequest -Uri 'https://<NRM_HOSTNAME>/health' -Headers $apiHeaders
```

Expected: Cloudflare Access rejects the request (normally HTTP 401 when that
option was enabled). It must not return the FastAPI health JSON.

Then send both Access headers and the FastAPI bearer token:

```powershell
$allHeaders = @{
  Authorization = 'Bearer <NRM_INTERNAL_API_TOKEN>'
  'CF-Access-Client-Id' = '<ACCESS_CLIENT_ID>'
  'CF-Access-Client-Secret' = '<ACCESS_CLIENT_SECRET>'
}
Invoke-RestMethod -Uri 'https://<NRM_HOSTNAME>/health' -Headers $allHeaders
```

Expected:

```text
status         service        schema_version
------         -------        --------------
ok             nrm-local-api  1.0
```

Finally, repeat with an intentionally wrong FastAPI bearer token while keeping
valid Access headers. Expected: FastAPI returns HTTP 401. These two negative
tests prove that neither authentication layer can substitute for the other.

## 8. Configure and redeploy Apps Script

In the main Apps Script project, open **Project Settings > Script Properties**
and add:

```text
NRM_LOCAL_API_BASE_URL=https://<NRM_HOSTNAME>
NRM_INTERNAL_API_TOKEN=<NRM_INTERNAL_API_TOKEN>
NRM_CF_ACCESS_CLIENT_ID=<ACCESS_CLIENT_ID>
NRM_CF_ACCESS_CLIENT_SECRET=<ACCESS_CLIENT_SECRET>
```

Copy the updated repository versions of `Config.gs` and `LocalAI.gs` into the
Apps Script editor. Then create a **new Apps Script deployment version** for the
existing web app. Saving code alone does not update the `/exec` deployment.
Keep the existing deployment URL so the Worker configuration does not change.

The resulting request carries three independent authentication headers:

```text
Authorization: Bearer <NRM_INTERNAL_API_TOKEN>
CF-Access-Client-Id: <ACCESS_CLIENT_ID>
CF-Access-Client-Secret: <ACCESS_CLIENT_SECRET>
```

## 9. Operational checks

- Confirm the Tunnel remains **Healthy** after rebooting Windows.
- Confirm `sc query cloudflared` reports `RUNNING` without a logged-in user.
- Confirm `http://127.0.0.1:8000/health` still works locally with the bearer
  token.
- Confirm the public hostname fails without Access credentials, fails with an
  invalid bearer token, and succeeds only when both layers are valid.
- Rotate the Access service token before expiration and update both Apps Script
  properties before revoking the old token.
- Update `cloudflared` manually on Windows; it does not auto-update.

## Official references

- Cloudflare Tunnel setup:
  https://developers.cloudflare.com/tunnel/get-started/
- Windows downloads:
  https://developers.cloudflare.com/tunnel/downloads/
- Quick Tunnel limitations:
  https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
- Access self-hosted applications:
  https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/
- Access service tokens:
  https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- Tunnel firewall requirements:
  https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/

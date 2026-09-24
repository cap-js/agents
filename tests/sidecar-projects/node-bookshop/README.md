# Node Bookshop Sidecar Sample

Agentify a Node.js CAP application by running the agent plugin in a sidecar (separate process).

> **Note:** For Node.js apps, running the agent in the same process is the simpler and recommended approach. This sample demonstrates the sidecar architecture for cases where a separate agent process is required.

## Prepare sidecar for your application

- ensure the Node.js app exposes its services via HCQL — add `"protocols": { "hcql": { "path": "/hcql" } }` to `package.json` and annotate the service with `@hcql`
- add the annotation `@agent` to the service you want to expose as an agent
- add folder `agent/sidecar` to the root folder of your application, add the following [package.json](agent/sidecar/package.json)

### Local development

- bind to a real aicore instance `cds bind -2 <your-aicore-instance>`
- in node-bookshop run: `cds watch` (port 4004)
- in node-bookshop/agent/sidecar run: `cds bind --exec cds watch`
  - the `agent-sidecar,node` profile is set in the sidecar's `package.json` — no extra `--profile` flag needed
  - the sidecar connects to the Node.js app at `localhost:4004/hcql/catalog`
- the sidecar should pick up the catalog service, the logs should show:
  ```
  Bootstrapping agent sidecar for node app { services: [ 'CatalogService' ] }
  ```
- then order a book via the agent:
  ```
  curl -s -X POST http://localhost:4006/a2a/catalog \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"message/send","params":{"message":{"kind":"message","messageId":"msg-1","role":"user","parts":[{"kind":"text","text":"order a copy of Wuthering Heights"}]}}}'
  ```

### Deployment

- the service "agent-node-bookshop-sidecar" in the [mta.yaml](./mta.yaml) deploys the sidecar
- the cds:[production] section in [package.json](agent/sidecar/package.json)
- for this example, the aicore service is called "test-aicore-client", adapt to the name of your aicore instance
- build and deploy (e.g. with `cds up`)
- when your application is running, get an OAuth token from the Node.js app, store it in APP_OAUTH_TOKEN and order a book via the agent:

  ```
  app_guid=$(cf app "agent-node-bookshop-srv" --guid 2>&1)
  credentials=$(cf curl "/v3/apps/${app_guid}/env" | jq -r --arg binding "agent-node-bookshop-auth" '.system_env_json.VCAP_SERVICES.xsuaa[] | select(.instance_name==$binding or .name==$binding) | .credentials | {clientid, clientsecret, url}')

  clientid=$(echo "$credentials" | jq -r '.clientid')
  clientsecret=$(echo "$credentials" | jq -r '.clientsecret')
  auth_url=$(echo "$credentials" | jq -r '.url')

  export APP_OAUTH_TOKEN=$(curl -s -X POST \
      -u "${clientid}:${clientsecret}" \
      -d 'grant_type=client_credentials&response_type=token' \
      "${auth_url}/oauth/token" | jq -r .access_token)

  curl -s -X POST https://<name-of-deployed-agent-node-bookshop-sidecar>.cfapps.eu12.hana.ondemand.com/a2a/catalog \
    -H "Content-Type: application/json" \
    -H "Authorization: bearer $APP_OAUTH_TOKEN" \
    -d '{"jsonrpc":"2.0","id":"1","method":"message/send","params":{"message":{"kind":"message","messageId":"msg-1","role":"user","parts":[{"kind":"text","text":"order a copy of wuthering heights"}]}}}'
  ```

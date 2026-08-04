# Java Bookshop Sample

Agentify a Java Application by running the Node agent plugin in a sidecar.

## Prepare sidecar for your application

- ensure the Java app exposes its services via HCQL — add `cds-adapter-hcql` as a runtime dependency in `pom.xml` and annotate the service with `@hcql` (without this, all agent tool calls will fail with a 400 error)
- add the annotation `@agent` to the service you want to expose as an agent
- add folder `agent/sidecar` to the root folder of your application, add the following [package.json](agent/sidecar/package.json)

### Local development

- bind to a real aicore instance `cds bind -2 <your-aicore-instance>`
- in java-bookshop/agent/sidecar run: `cds bind --exec cds watch --profile java,hybrid`
  - the `java` profile tells the sidecar it is connecting to a Java CAP app (`_javaHcqlCompat: true`), which:
    - routes action/function calls via the HCQL envelope format `{"event":"<action>","args":[...]}`
    - connects to the Java app at `localhost:8080/hcql` (instead of the Node default `localhost:4004/hcql`)
- in java-bookshop run: `mvn spring-boot:run`
- the sidecar should pick up the catalog service, the logs should show:
  ```
  Bootstrapping agent sidecar for java app { services: [ 'CatalogService' ] }
  ```
- then order a book via the agent:
  ```
  curl -s -X POST http://localhost:4006/a2a/catalog \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"1","method":"message/send","params":{"message":{"kind":"message","messageId":"msg-1","role":"user","parts":[{"kind":"text","text":"Order a copy of wuthering heights"}]}}}'
  ```

### Deployment

- the service "agent-java-bookshop-sidecar" in the [mta.yaml](./mta.yaml) deploys the sidecar
- the cds:[production] section in [package.json](agent/sidecar/package.json)
- for this example, the aicore service is called "test-aicore-client", adapt to the name of your aicore instance
- build and deploy (e.g. with `cds up`)
- when your application is running, get a oauth token from the java app, store it in APP_OAUTH_TOKEN and order a book via the agent:

  ```
  app_guid=$(cf app "agent-java-bookshop-srv" --guid 2>&1)
  credentials=$(cf curl "/v3/apps/${app_guid}/env" | jq -r --arg binding "agent-java-bookshop-auth" '.system_env_json.VCAP_SERVICES.xsuaa[] | select(.instance_name==$binding or .name==$binding) | .credentials | {clientid, clientsecret, url}')

  clientid=$(echo "$credentials" | jq -r '.clientid')
  clientsecret=$(echo "$credentials" | jq -r '.clientsecret')
  auth_url=$(echo "$credentials" | jq -r '.url')

  export APP_OAUTH_TOKEN=$(curl -s -X POST \
      -u "${clientid}:${clientsecret}" \
      -d 'grant_type=client_credentials&response_type=token' \
      "${auth_url}/oauth/token" | jq -r .access_token)

  curl -s -X POST https://<name-of-deployed-agent-java-bookshop-sidecar>.cfapps.eu12.hana.ondemand.com/a2a/catalog \
    -H "Content-Type: application/json" \
    -H "Authorization: bearer $APP_OAUTH_TOKEN" \
    -d '{"jsonrpc":"2.0","id":"1","method":"message/send","params":{"message":{"kind":"message","messageId":"msg-1","role":"user","parts":[{"kind":"text","text":"order a copy of wuthering heights"}]}}}'
  ```

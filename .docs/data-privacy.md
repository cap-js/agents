# Data Privacy

> [!WARNING]
> The following features are experimental and may be changed or removed at any time.

## Data Retention

The plugin automatically triggers a cleanup of Tasks, and its related entities (Checkpoints, Files, A2A Push Notification configuration).

The TTL can be configured via `cds.agents.retention`. The default is 30 days and acceptable values are time strings like `30d` or raw millisecond values. Setting it to `false` or `0` disables it.

```json
{
  "cds": {
    "agents": {
      "retention": "30d"
    }
  }
}
```

For all tasks created within a 24h window for a specific Agent service, a single deletion is scheduled via `srv.schedule("cleanupTasks").after(TTL)`.

## Pseudonymization of Personal Data in tool calls

When your CDS entities carry `@PersonalData` annotations, the plugin pseudonymizes those fields before they reach the LLM — and before they are written to OTel traces. Users always see real values in the final response.

### Setup

Enable pseudonymization:

```json
{ "cds": { "agents": { "masking": true } } }
```

Annotate fields in your CDS model:

```cds
entity Authors {
  key ID       : Integer;

  @PersonalData.IsPotentiallyPersonal
  name         : String;

  @PersonalData.IsPotentiallySensitive
  dateOfBirth  : Date;
}
```

The plugin handles the rest automatically:

- **LLM** sees `name-a8f3d2c1` instead of `"Emily Brontë"` — it reasons with the pseudonymous value but never sees real data.
- **User** receives the real value in the final response — hashes are resolved before the answer is returned.
- **OTel traces and MLflow** record hashed values by default, keeping telemetry DPP-compliant.
- **Multi-turn conversations** work across service instances — the same value always maps to the same hash within a session, and hashes are resolved back to originals before tool calls execute.

### Supported annotations

| Annotation                                      | Effect              |
| ----------------------------------------------- | ------------------- |
| `@PersonalData.IsPotentiallyPersonal`           | Field pseudonymized |
| `@PersonalData.IsPotentiallySensitive`          | Field pseudonymized |
| `@PersonalData.FieldSemantics: 'UserID'`        | Field pseudonymized |
| `@PersonalData.FieldSemantics: 'DataSubjectID'` | Field pseudonymized |

Applies to all field types except `Boolean`, `Date`, `DateTime`, and `Timestamp`. Numeric properties are only hashed if they are a key or foreign key property.

### Opting out

If a field must be sent to the LLM as-is — for example a display name the LLM needs to include verbatim in its response — add `@Common.Masked: false`. OTel traces are still scrubbed.

```cds
entity Contacts {
  @PersonalData.IsPotentiallyPersonal
  @Common.Masked: false   // LLM sees the real value; trace still hashed
  displayName : String;
}
```

### Viewing real values in traces (dev/test)

Set `resolveInTraces: true` to see original values in OTel spans during development:

```json
{ "cds": { "agents": { "masking": { "resolveInTraces": true } } } }
```

## Pseudonymization of Personal Data in incoming user messages

While CDS annotations can be leveraged to mask PII in structured data returned from tools, incoming user messages are unstructured data about which no metadata exists to easily mask PII.

To identify and mask PII in unstructured data, [SAP DPI Data Anonymization](https://help.sap.com/docs/data-privacy-integration/development-for-data-privacy-integration/data-privacy-integration-nextgen-data-anonymization?ai=true) and [SAP HANA Cloud Named Entity Recognition](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-predictive-analysis-library/named-entity-recognition-ner) can be leveraged.

To leverage this feature masking must be enabled:

```json
{ "cds": { "agents": { "masking": true } } }
```

### DPI Data Anonymization

The plugin can call SAP Data Privacy Integration (DPI) through a BTP Destination before the agent model runs. It pseudonymizes only incoming human messages in the current turn; tool output, system prompts, and model responses are not sent to DPI.

1. Create a DPI service instance for pseudonymization:

```sh
cf create-service data-privacy-integration-service enterprise bookshop-anonymization -c '{ "dataPrivacyConfiguration": { "configType": "anonymization", "applicationConfiguration": { "applicationName": "bookshop-srv", "applicationDescription": "Pseudonymization for Bookshop Service"}}}'
```

2. Go to the Subaccount. Under Connectivity -> Destination Certificates create a new certificate.
3. Under Destination create a new destination using the certificate. The minimal working config is:

```json
{
  "Authentication": "ClientCertificateAuthentication",
  "Name": "bookshop-srv-pseudonymization",
  "KeyStore.Source": "DestinationService",
  "KeyStoreLocation": "<select certificate in BTP>",
  "ProxyType": "Internet",
  "Type": "HTTP",
  // Change eu12 to the BTP region of your subaccount
  "URL": "https://service.eu10.anonymization.dpp.cloud.sap"
}
```

4. Follow the SAP DPI documentation for [Service Provisioning for External Consumers](https://help.sap.com/docs/data-privacy-integration/development/service-provisioning-for-external-consumers)

- Download the certificate
- Convert it into a single string with explicit `\r\n` line ends.
- Create a service key with the parameters

```json
{
  "credentials": {
    "certificate": "-----BEGIN CERTIFICATE-----\r\n...\r\n-----END CERTIFICATE-----\r\n"
  }
}
```

This is mandatory for connectivity. Else a 401 error with `Certificate not registered` will be thrown at runtime.

5. Bind the Destination service to the application and provide the destination name as follows:

```jsonc
{
  "cds": {
    "requires": {
      "data-anonymization": {
        "credentials": { "destination": "bookshop-srv-pseudonymization" },
      },
    },
  },
}
```

The following profiles are configued to be pseudonymized:

- "profile-person",
- "profile-email",
- "profile-phone",
- "profile-address",
- "profile-username-password",
- "profile-nationalid",
- "profile-iban",
- "profile-ssn",
- "profile-credit-card-number",
- "profile-passport",
- "profile-driverlicense",

### HANA Cloud Named Entity Recognition

HANA Cloud Named Entity Recognition is used to pseudonymize PII in incoming user messages when HANA Cloud is used as the database and the ScriptServer as well as the NLP feature are enabled.

The Script Server and NLP can be enabled in HANA Cloud Cockpit.

Furthermore the database administrator should run

```sql
GRANT "AFL__SYS_AFL_AFLPAL_NLP_EXECUTE_WITH_GRANT_OPTION" TO "_SYS_DI_OO_DEFAULTS" WITH ADMIN OPTION;
```

in order for the HDI container to have access to the PAL function used for detecting PII.

In particular the following categories from NER are pseudonymized:

- "PERSON"
- "URI:EMAIL"
- "PHONE"
- "ADDRESS"
- "URI:URL"
- "URI:IP"

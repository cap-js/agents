using { Currency, managed } from '@sap/cds/common';

namespace test.otelv1;

entity Books : managed {
  key ID    : Integer;
      title : String(111) @mandatory;
      stock : Integer;
}

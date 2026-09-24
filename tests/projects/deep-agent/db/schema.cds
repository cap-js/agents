namespace sample.products;

entity Products {
  key ID    : UUID;
      name  : String(100);
      price : Decimal(10,2);
      stock : Integer;
      category : String(50);
}

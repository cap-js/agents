using {sap.capire.bookshop as my} from '../db/schema';

@agent
service StatusUpdateService {
  @readonly
  entity BooksTextFirst as projection on my.Books {
    ID,
    title,
  };

  @readonly
  entity BooksTextLast as projection on my.Books {
    ID,
    title,
  };

  @readonly
  entity BooksTextOnly as projection on my.Books {
    ID,
    title,
  };

  @readonly
  entity BooksTextSeparate as projection on my.Books {
    ID,
    title,
  };

  @readonly
  entity BooksTextPath as projection on my.Books {
    ID,
    author,
  };

  @readonly
  entity BooksWithoutText as projection on my.Books {
    ID as code,
    title,
  };

  @readonly entity ExternalIdDirect as projection on my.ExternalIdValues;
  @readonly entity ExternalIdDirectXpr as projection on my.ExternalIdValues;
  @readonly entity ExternalIdPath as projection on my.ExternalIdPaths;
  @readonly entity ExternalIdPathXpr as projection on my.ExternalIdPaths;

  @Core.Messages: [{ code: 'agent-status-update', message: 'Text first: {book}' }]
  action textFirst(book: Integer @Common.ValueList: {
    CollectionPath: 'BooksTextFirst',
    Parameters: [{ $Type: 'Common.ValueListParameterInOut', LocalDataProperty: book, ValueListProperty: 'ID' }],
  }) returns String;

  @Core.Messages: [{ code: 'agent-status-update', message: 'Text last: {book}' }]
  action textLast(book: Integer @Common.ValueList: {
    CollectionPath: 'BooksTextLast',
    Parameters: [{ $Type: 'Common.ValueListParameterInOut', LocalDataProperty: book, ValueListProperty: 'ID' }],
  }) returns String;

  @Core.Messages: [{ code: 'agent-status-update', message: 'Text only: {book}' }]
  action textOnly(book: Integer @Common.ValueList: {
    CollectionPath: 'BooksTextOnly',
    Parameters: [{ $Type: 'Common.ValueListParameterInOut', LocalDataProperty: book, ValueListProperty: 'ID' }],
  }) returns String;

  @Core.Messages: [{ code: 'agent-status-update', message: 'Text separate: {book}' }]
  action textSeparate(book: Integer @Common.ValueList: {
    CollectionPath: 'BooksTextSeparate',
    Parameters: [{ $Type: 'Common.ValueListParameterInOut', LocalDataProperty: book, ValueListProperty: 'ID' }],
  }) returns String;

  @Core.Messages: [{ code: 'agent-status-update', message: 'Text path: {book}' }]
  action textPath(book: Integer @Common.ValueList: {
    CollectionPath: 'BooksTextPath',
    Parameters: [{ $Type: 'Common.ValueListParameterInOut', LocalDataProperty: book, ValueListProperty: 'ID' }],
  }) returns String;

  @Core.Messages: [{ code: 'agent-status-update', message: 'No text: {book}' }]
  action noText(book: Integer @Common.ValueList: {
    CollectionPath: 'BooksWithoutText',
    Parameters: [{ $Type: 'Common.ValueListParameterInOut', LocalDataProperty: book, ValueListProperty: 'code' }],
  }) returns String;

  @Core.Messages: [{ code: 'agent-status-update', message: 'Plain: {book}' }]
  action plain(book: Integer) returns String;

  @Core.Messages: [{ code: 'agent-status-update', message: 'External direct: {value}' }]
  action externalDirect(value: Integer @Common.ValueList: { CollectionPath: 'ExternalIdDirect', Parameters: [{ $Type: 'Common.ValueListParameterInOut', LocalDataProperty: value, ValueListProperty: 'ID' }] }) returns String;

  @Core.Messages: [{ code: 'agent-status-update', message: 'External direct xpr: {value}' }]
  action externalDirectXpr(value: Integer @Common.ValueList: { CollectionPath: 'ExternalIdDirectXpr', Parameters: [{ $Type: 'Common.ValueListParameterInOut', LocalDataProperty: value, ValueListProperty: 'ID' }] }) returns String;

  @Core.Messages: [{ code: 'agent-status-update', message: 'External path: {value}' }]
  action externalPath(value: Integer @Common.ValueList: { CollectionPath: 'ExternalIdPath', Parameters: [{ $Type: 'Common.ValueListParameterInOut', LocalDataProperty: value, ValueListProperty: 'ID' }] }) returns String;

  @Core.Messages: [{ code: 'agent-status-update', message: 'External path xpr: {value}' }]
  action externalPathXpr(value: Integer @Common.ValueList: { CollectionPath: 'ExternalIdPathXpr', Parameters: [{ $Type: 'Common.ValueListParameterInOut', LocalDataProperty: value, ValueListProperty: 'ID' }] }) returns String;
}

annotate StatusUpdateService.BooksTextFirst with { ID @Common.Text: title @Common.TextArrangement: #TextFirst; };
annotate StatusUpdateService.BooksTextLast with { ID @Common.Text: (title) @Common.TextArrangement: #TextLast; };
annotate StatusUpdateService.BooksTextOnly with { ID @Common.Text: title @Common.TextArrangement: #TextOnly; };
annotate StatusUpdateService.BooksTextSeparate with { ID @Common.Text: title @Common.TextArrangement: #TextSeparate; };
annotate StatusUpdateService.BooksTextPath with { ID @Common.Text: (author.name) @Common.TextArrangement: #TextOnly; };
annotate StatusUpdateService.BooksWithoutText with { code @Common.Text: null; };
annotate StatusUpdateService.ExternalIdDirect with { ID @Common.ExternalID: identifier; };
annotate StatusUpdateService.ExternalIdDirectXpr with { ID @Common.ExternalID: (identifier); };
annotate StatusUpdateService.ExternalIdPath with { ID @Common.ExternalID: status.identifier; };
annotate StatusUpdateService.ExternalIdPathXpr with { ID @Common.ExternalID: (status.identifier); };

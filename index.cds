using { cuid, managed } from '@sap/cds/common';
// using {Attachments} from '@cap-js/attachments'; // TODO
using from './srv/agents'; 

namespace cap.agent;

entity Messages : cuid, managed {
  session  : UUID; // A2A contextId — groups messages into a conversation
  sequence : Integer;
  prev     : Association to Messages; // first message of a forked session points here
  role     : RoleType;
  type     : MessageType;
  content  : LargeString;
  query    : Map;
}

view Sessions as
  select from Messages {
    key session         as ID,
        min(createdAt)  as createdAt,
        max(modifiedAt) as modifiedAt,
  }
  group by
    session;

type RoleType    : String enum {
  user;
  assistant;
  system;
  tool;
};

type MessageType : String enum {
  text;
  image;
  file;
  tool_call;
  tool_result;
  reasoning;
  data;
};

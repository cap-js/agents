---
name: custom-book-agent
description: A custom book recommendation agent with hand-crafted skills.
version: "2.0.0"
defaultInputModes: [text/plain]
defaultOutputModes: [text/plain]
skills:
  - id: book-recommendations
    name: Book Recommendations
    description: Get personalized book recommendations based on genre or mood.
    tags: [books, recommendations, reading]
    examples:
      - Recommend a mystery novel
      - What should I read next?
      - Suggest something for a rainy day
  - id: reading-list
    name: Reading List Management
    description: Track books you want to read, are reading, or have finished.
    tags: [books, lists, tracking]
    examples:
      - Add Wuthering Heights to my reading list
      - What books am I currently reading?
      - Mark Dune as finished
---

# Custom Book Agent

This card is defined explicitly in AGENT_CARD.md rather than generated from skills/ or CDS model. This text is ignored.

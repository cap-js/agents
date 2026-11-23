using from '../../srv/mtx-service';

annotate MtxTestService with
  @agent.directory: './experimental-agent'
  @agent.model: 'experimental-model-name'
  @agent.llm: 'another-llm';

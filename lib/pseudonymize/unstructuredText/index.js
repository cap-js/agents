import { anonymizeUserMessage as hana } from './hana';
import { anonymizeUserMessage as dpi } from './dpi';

export default async function anonymizeUserMessage(requestContext, serviceName) {
    await hana(requestContext, serviceName)
    await dpi(requestContext, serviceName)
}
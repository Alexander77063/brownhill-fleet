import { PageHeader } from '@/components/ui';
import { AssistantPanel } from '@/components/ops/AssistantPanel';

export const dynamic = 'force-dynamic';

export default async function AssistantPage() {
  return (
    <>
      <PageHeader
        eyebrow="AI"
        title="Fleet Assistant"
        subtitle="Your private assistant, grounded in your own fleet data."
      />
      <AssistantPanel />
    </>
  );
}

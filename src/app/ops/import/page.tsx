import { PageHeader } from '@/components/ui';
import { ImportForm } from './ImportForm';

export const dynamic = 'force-dynamic';

export default function ImportPage() {
  return (
    <>
      <PageHeader
        eyebrow="Data"
        title="Bulk import"
        subtitle="Add vehicles or drivers in bulk from a spreadsheet. Preview validates before anything is saved."
      />
      <ImportForm />
    </>
  );
}

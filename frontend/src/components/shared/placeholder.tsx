import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from './page-header';

/** 占位页：实现阶段由各特性组替换。 */
export function Placeholder({ title, doc, children }: { title: string; doc?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={title} description={doc} />
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          {children ?? '此页面将在实现阶段填充；设计与契约见 frontend/docs。'}
        </CardContent>
      </Card>
    </div>
  );
}

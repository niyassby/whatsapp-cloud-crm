import type { FlowDto } from '@wacrm/shared';
import { Badge } from '@/components/ui/badge';

/** Draft, or on/off with the published version and whether the draft has moved on. */
export function FlowState({ flow }: { flow: FlowDto }) {
  if (!flow.publishedVersion) return <Badge variant="outline">Draft</Badge>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge variant={flow.active ? 'default' : 'secondary'}>{flow.active ? 'On' : 'Off'}</Badge>
      <span className="text-xs text-muted-foreground">v{flow.publishedVersion}</span>
      {flow.hasUnpublishedChanges && (
        <span className="text-xs text-muted-foreground">· unpublished changes</span>
      )}
    </span>
  );
}

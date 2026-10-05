import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./Button";

export function Pagination({ page, size, total, onPage }: { page: number; size: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (total <= size) return null;
  return (
    <nav className="mt-4 flex items-center justify-between text-sm text-muted" aria-label="Pagination">
      <span className="tnum">{page * size + 1}–{Math.min((page + 1) * size, total)} sur {total}</span>
      <div className="flex items-center gap-2">
        <Button size="sm" icon={<ChevronLeft className="size-4" />} disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Page précédente" />
        <span className="tnum min-w-16 text-center">Page {page + 1} / {pages}</span>
        <Button size="sm" icon={<ChevronRight className="size-4" />} disabled={page + 1 >= pages} onClick={() => onPage(page + 1)} aria-label="Page suivante" />
      </div>
    </nav>
  );
}

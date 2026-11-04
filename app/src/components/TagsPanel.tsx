import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { TagCount } from "../api/generated/TagCount";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";

/** Every tag in the vault, with how many notes use it. */
export function TagsPanel() {
  const revision = useVault((s) => s.revision);
  const [tags, setTags] = useState<TagCount[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .tags()
      .then((t) => !cancelled && setTags(t))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [revision]);

  if (!tags) return null;
  if (tags.length === 0) return <p className="panel-empty muted">No tags yet.</p>;
  return (
    <ul className="tags-list" aria-label="Tags">
      {tags.map((t) => {
        const parts = t.tag.split("/");
        return (
          <li key={t.tag}>
            <button
              className="tag-row"
              title={`Search for #${t.tag}`}
              onClick={() => useUi.getState().searchFor(`#${t.tag}`)}
            >
              <span className="tag-name">
                {parts.length > 1 && (
                  <span className="tag-parent">{parts.slice(0, -1).join("/")}/</span>
                )}
                {parts[parts.length - 1]}
              </span>
              <span className="tag-count">{t.count}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

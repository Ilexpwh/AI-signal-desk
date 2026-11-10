import { SITE } from "@aihot/site";
import { Form, Link, useNavigate, useSearchParams } from "react-router";
import type { Route } from "./+types/content";
import type { AdminContentRow, AdminContentSearch, AdminUnmatchedSubjects } from "@aihot/contracts/admin";
import { adminGet } from "../../lib/admin.server";
import { VISIBILITY_LABEL } from "../../features/admin/labels";
import { AdminPage, Badge, Button, Card, DataTable, Empty, Input, Time } from "../../features/admin/ui";


export async function loader({ request }: Route.LoaderArgs) {
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return { q, rows: [] as AdminContentRow[], unmatched: await adminGet<AdminUnmatchedSubjects>(request, "/api/admin/unmatched-subjects") };
  const { rows } = await adminGet<AdminContentSearch>(request, `/api/admin/content?q=${encodeURIComponent(q)}`);
  return { q, rows, unmatched: null };
}

export const meta: Route.MetaFunction = () => [{ title: `内容诊断 · ${SITE.name} 后台` }];

export default function Content({ loaderData }: Route.ComponentProps) {
  const { q, rows, unmatched } = loaderData;
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  return (
    <AdminPage title="内容诊断" subtitle="按 ID、原文链接或标题找到任何一条内容，看它从信源到公开出口的完整链路；下架、仅摘要、人工修正和重处理都在详情页。">
      <Form method="get" className="mb-5 flex max-w-2xl gap-2">
        <Input name="q" defaultValue={sp.get("q") ?? ""} placeholder="内容 ID、URL 或标题关键词" aria-label="搜索内容" autoFocus />
        <Button type="submit" tone="primary">查找</Button>
      </Form>
      {q && (
        <Card pad={false} title={`“${q}” 的结果`} right={<span>{rows.length === 50 ? "仅显示最近 50 条" : `${rows.length} 条`}</span>}>
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/admin/content/${r.id}`)}
            empty="没有找到。URL 会先规范化再比对；标题支持中英文片段。"
            columns={[
              {
                key: "t",
                label: "标题",
                render: (r) => (
                  <div className="min-w-[320px]">
                    <Link to={`/admin/content/${r.id}`} className="font-medium text-ink hover:text-accent" onClick={(e) => e.stopPropagation()}>{r.title}</Link>
                    <div className="font-mono text-[11.5px] text-ink-4">{r.id}</div>
                  </div>
                ),
              },
              { key: "src", label: "信源", render: (r) => <span className="whitespace-nowrap">{r.source}</span> },
              {
                key: "st",
                label: "状态",
                render: (r) => (
                  <span className="flex flex-wrap gap-1">
                    {r.selected && <Badge tone="accent">精选</Badge>}
                    {r.visibility && <Badge tone={r.visibility === "public" ? "muted" : "warn"}>{VISIBILITY_LABEL[r.visibility] ?? r.visibility}</Badge>}
                    {!r.visibility && <Badge>{r.processing_state}</Badge>}
                  </span>
                ),
              },
              { key: "sc", label: "分数", align: "right", render: (r) => r.score ?? "—" },
              { key: "d", label: "发现", render: (r) => <Time at={r.discovered_at} /> },
            ]}
          />
        </Card>
      )}
      {!q && <Empty>输入 ID、链接或标题开始查找。</Empty>}
      {unmatched && <UnmatchedSubjects list={unmatched} />}
    </AdminPage>
  );
}

/** Fact subjects the company list does not know: the owner adds a company or an alias in industry/taxonomy.ts. */
function UnmatchedSubjects({ list }: { list: AdminUnmatchedSubjects }) {
  return (
    <Card pad={false} title="未收录主体" right={<span>近 {list.days} 天出现 {list.min} 次以上</span>}>
      <p className="border-b border-line px-4 py-3 text-[12.5px] leading-relaxed text-ink-3">
        结构抽取写出的事实主体里，对不上 <code>industry/taxonomy.ts</code> 公司名录（<code>ENTITIES</code> 的名字和别名）的名字。对不上的主体不算哪家公司的一手发布，也不会归进公司主题；要收录，在名录里加这家公司或给已有的公司加别名，重新构建后生效，之后这里就不再列它。“身份词典”是 <code>IDENTITY_LEXICON</code> 在名字里认出的公司，多半是缺了这个别名。
      </p>
      <DataTable
        rows={list.rows}
        rowKey={(r) => r.name}
        empty="没有要收录的名字。"
        columns={[
          { key: "n", label: "名字", render: (r) => <span className="font-medium text-ink">{r.name}</span> },
          { key: "c", label: "篇数", align: "right", render: (r) => r.count },
          { key: "l", label: "身份词典", render: (r) => (r.lexicon.length ? <span className="flex flex-wrap gap-1">{r.lexicon.map((name) => <Badge key={name}>{name}</Badge>)}</span> : "—") },
          {
            key: "d",
            label: "最近一篇",
            render: (r) => <Link to={`/admin/content/${r.latest_article_id}`} className="hover:text-accent"><Time at={r.last_seen_at} /></Link>,
          },
        ]}
      />
    </Card>
  );
}

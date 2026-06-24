import { useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import readmeRaw from "../../../README.md?raw";
import { openExternal } from "../lib/external";

// 使用说明 = 仓库根 README.md 的内容，构建时以 ?raw 内置进包，离线渲染，避免联网取文档出错。
export default function HelpPage() {
  const navigate = useNavigate();
  return (
    <div className="help-page">
      <div className="help-head">
        <button className="back-icon" onClick={() => navigate(-1)} aria-label="返回">◀</button>
        <h1>使用说明</h1>
      </div>
      <div className="help-md">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // 外部链接走系统浏览器，避免在 WebView 里导航离开应用。
            a: ({ href, children }) => (
              <a
                href={href}
                onClick={(e) => {
                  e.preventDefault();
                  if (href && /^https?:/i.test(href)) openExternal(href);
                }}
              >
                {children}
              </a>
            ),
          }}
        >
          {readmeRaw}
        </ReactMarkdown>
      </div>
    </div>
  );
}

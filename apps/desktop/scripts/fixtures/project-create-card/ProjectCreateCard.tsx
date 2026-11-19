import { useId } from "react";
import "./ProjectCreateCard.css";

/** Review-only card. No project is created by this isolated preview. */
export function ProjectCreateCard({ onCreate }: { onCreate: () => void }) {
  const id = useId().replaceAll(":", "");
  return <div className="project-manager-card project-create-card">
    <button type="button" className="project-manager-activate" aria-label="新建项目" onClick={onCreate}/>
    <div className="library-project-enter project-create-body" aria-hidden="true">
      <div className="project-manager-card-head"><span className="project-create-head-mark"/></div>
      <div className="library-project-mosaic project-create-art">
        <svg className="project-create-layer is-base" viewBox="0 0 400 240" preserveAspectRatio="xMidYMid slice" fill="none">
          <defs>
            <pattern id={`${id}-grid`} width="24" height="24" patternUnits="userSpaceOnUse">
              <path d="M24 0H0V24" stroke="currentColor" strokeOpacity=".12" strokeWidth=".55"/>
              <path d="M0 11v2m11-13h2" stroke="currentColor" strokeOpacity=".35" strokeWidth=".6"/>
            </pattern>
          </defs>
          <path d="M0 0H400V240H0Z" fill={`url(#${id}-grid)`}/>
          <g fill="currentColor">
            <path opacity=".045" d="M21 8h68v194H21zM41 163h203v55H41z"/>
            <path opacity=".06" d="M296 9h83v88h-83z"/>
          </g>
          <g stroke="currentColor" strokeWidth=".65" opacity=".3">
            <path d="M17 0V240M88 0V240M142 0V240M291 0V240M381 0V240M0 31H400M0 86H400M0 161H400M0 218H400"/>
            <circle cx="68" cy="154" r="77"/><circle cx="68" cy="154" r="61"/>
            <path d="M68 61V237M0 154H163M187 8h171m-171 4h69M20 227H380"/>
            <path strokeDasharray="1 3" d="M93 0V240M0 166H400M296 0V240"/>
          </g>
          <g stroke="currentColor" strokeWidth=".7" opacity=".55">
            {Array.from({ length: 28 }, (_, index) => <path key={`y-${index}`} d={`M17 ${8 + index * 8}h${index % 4 === 0 ? 8 : 3}`}/>)}
            {Array.from({ length: 30 }, (_, index) => <path key={`x-${index}`} d={`M${36 + index * 11} 218v${index % 5 === 0 ? 7 : 3}`}/>)}
            <path d="M45 129h10m-5-5v10M83 188h10m-5-5v10M329 48h10m-5-5v10"/>
          </g>
          <g fill="currentColor" opacity=".38">
            {Array.from({ length: 42 }, (_, index) => <rect key={index} x={267 + index % 7 * 17} y={124 + Math.floor(index / 7) * 16} width={index % 5 === 0 ? 3 : 1.5} height={index % 5 === 0 ? 3 : 1.5}/>)}
          </g>
          <g stroke="currentColor" strokeWidth=".8" opacity=".5">
            <path d="M34 42h28m-28 4h14m-14 4h20M319 22h36m-36 4h13m-13 4h24M184 198h42m-42 4h28m-28 4h14"/>
            <path d="M54 79v-8h10M353 180h10v-10M118 230v4h24"/>
          </g>
        </svg>
        <svg className="project-create-layer is-planes" viewBox="0 0 400 240" fill="none">
          <g stroke="currentColor" strokeWidth=".8">
            <path className="project-create-plane plane-rear" d="M75 116 242 65 332 147 165 198Z"/>
            <path className="project-create-plane plane-middle" d="M75 94 242 43 332 125 165 176Z"/>
            <path className="project-create-plane plane-front" d="M75 72 242 21 332 103 165 154Z"/>
            <path opacity=".35" strokeDasharray="2 3" d="M75 72v44M242 21v44M332 103v44M165 154v44"/>
            <path opacity=".24" d="M93 78 240 33 314 99 167 142ZM131 56 221 138M186 38 276 120M105 99 272 48"/>
          </g>
        </svg>
        <svg className="project-create-layer is-signal" viewBox="0 0 400 240" fill="none">
          <g className="project-create-flash" stroke="currentColor" strokeWidth="1.15">
            <path d="M76 87V72l17-5M225 26l17-5 11 10M321 93l11 10-17 5M154 144l11 10 17-5"/>
            <path d="M191 87h26M204 74v26" strokeWidth="1.5"/>
            <path d="M88 161h44M343 62v31" strokeWidth="2.5"/>
          </g>
          <g className="project-create-flash is-delayed" fill="currentColor">
            <path d="M72 69h5v5h-5zM240 19h4v4h-4zM330 101h4v4h-4zM163 152h4v4h-4zM379 215h4v4h-4zM65 151h6v6h-6z"/>
            <path opacity=".65" d="M34 24h3v3h-3zM38 24h3v3h-3zM42 24h3v3h-3zM46 24h3v3h-3zM34 29h3v3h-3zM42 29h3v3h-3zM46 29h3v3h-3z"/>
          </g>
        </svg>
      </div>
      <div className="project-folder-info project-create-footer">
        <span className="project-manager-card-kind"><svg className="project-create-registration" width="18" height="9" viewBox="0 0 18 9"><path d="M0 4h18"/></svg></span>
        <div className="library-project-folder-title">
          <strong className="project-create-caption">新建项目</strong>
          <svg className="project-create-arrow" viewBox="0 0 44 20" fill="none">
            <path d="M2 10h34m-7-7 7 7-7 7"/>
          </svg>
        </div>
        <div className="project-manager-meta project-create-meta"/>
      </div>
    </div>
  </div>;
}

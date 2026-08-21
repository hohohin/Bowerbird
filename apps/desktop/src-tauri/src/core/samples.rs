//! 首启预置示例图：新用户首次打开应用时把 8 张图随包注入素材库，
//! 每张预填 caption（11 维度）+ auto tag + 主色（ingest 自动），破解空状态。
//! 全程不调 codex（caption 由 manifest 预填，符合离线降级约定 7）。
//!
//! 数据驱动：加图 / 改文案只动下方的 `SAMPLES` const 表与 `CAPTION_*` 文本，
//! 注入逻辑（`seed_if_first_launch` / `seed_one`）不变。
//!
//! 8 张图的维度数据为用户提供（onboarding-samples.md），正文原样保留。
//! 注意：维度顺序为「类型 → ratio → 构图 → …」，而 `ratio` 与 `构图` 都别名映射到
//! composition，`map_dimensions` 用 or_insert_with 先到先得——故 `dimensions.composition`
//! 取「ratio」段落正文（画幅比例说明），「构图」段落只进 sections（详情页仍完整展示）。
//!
//! 阶段 B 起首启注入改用 `preset` 模块（generation_meta 识别）；本模块保留 caption 预填
//! 逻辑 + 测试，并提供 `resolve_samples_dir` 供 `release_preset_pack` 复用。生产不再调用。

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use crate::core::caption;
use crate::core::ingest;
use crate::core::library::Analysis;
use crate::core::paths::LibraryPaths;
use crate::core::settings::SettingsState;
use crate::db::Database;
use crate::error::AppResult;

/// 预置图写入 `assets.source` 的标记值（未来前端可按 `source:sample` 筛选/角标，MVP 不做）。
const SAMPLE_SOURCE: &str = "sample";
/// caption payload 的 instruction 字段（标识这是示例预填，非 codex 反推）。
const SEED_INSTRUCTION: &str = "示例预填";

/// 一张示例图的 manifest 项。
#[derive(Clone)]
struct SampleSpec {
    /// 对应 resources/samples/<filename>（随安装包内嵌）。
    filename: &'static str,
    /// 11 维度 markdown 文本，由 caption::parse 解析为 sections + dimensions。
    caption: &'static str,
    /// auto tag 名（须在 0005 seed 词表内：人像/风景/静物/美食/动物/建筑/抽象/插画/室内/街景）。
    tags: &'static [&'static str],
}

// tags 为按图内容推断的归类（均可调整），全部在 seed 词表内。
const SAMPLES: &[SampleSpec] = &[
    SampleSpec {
        filename: "flower-thick-oil.webp",
        caption: CAPTION_FLOWER,
        tags: &["静物"],
    },
    SampleSpec {
        filename: "sheep-newyear.webp",
        caption: CAPTION_SHEEP,
        tags: &["插画"],
    },
    SampleSpec {
        filename: "collage-traveler.webp",
        caption: CAPTION_COLLAGE,
        tags: &["插画"],
    },
    SampleSpec {
        filename: "camper-beach.webp",
        caption: CAPTION_CAMPER,
        tags: &["插画"],
    },
    SampleSpec {
        filename: "cat-pomegranate.webp",
        caption: CAPTION_CAT,
        tags: &["动物"],
    },
    SampleSpec {
        filename: "zen-still-life.webp",
        caption: CAPTION_ZEN,
        tags: &["静物"],
    },
    SampleSpec {
        filename: "fashion-portrait.webp",
        caption: CAPTION_FASHION,
        tags: &["人像"],
    },
    SampleSpec {
        filename: "outdoor-portrait.webp",
        caption: CAPTION_OUTDOOR,
        tags: &["人像"],
    },
];

const CAPTION_FLOWER: &str = r#"
- **类型**
AI生成的数字绘画作品，属于带有厚涂油画质感的装饰艺术海报/插画，非摄影实拍、非实体3D建模作品，兼具手绘艺术表现力与平面海报的排版适配属性。

- **ratio**
竖版画幅，画面比例约为2:3，属于适配移动端传播、常规海报应用的竖长比例。

- **构图**
采用上轻下重的稳定竖版构图，视觉重心集中在画面中下部的花卉主体区域；画面顶部、底部边缘预留充足的排版承载空间，排版元素未过度遮挡核心绘画内容；花束枝叶带有自然向上舒展的动势，整体上虚下实，视觉平衡感强；采用中景取景距离，完整呈现花束核心形态，画面边缘点缀自然飞溅的笔触作为视觉延伸，无逼仄压抑感。

- **光影**
采用柔和的正面漫射光效，无强烈硬边阴影，也无明确的强指向性光源；明暗过渡自然柔和，亮部高光集中在浅色花瓣的厚涂笔触凸起位置，暗部集中在花束下层的深色叶片区域，整体明暗反差适中，曝光均衡，无过曝、大面积死黑区域，无刻意添加的发光边缘效果，光影表现服务于花卉体积与质感的呈现。

- **色调**
以沉稳的冷调暗墨绿色作为主色调，占据画面大面积基底区域；搭配暖橙红色、奶白色、明黄色、深炭黑色作为辅助色表现花卉与枝叶；色彩饱和度层次分明，背景为中低饱和度，主体花卉为中高饱和度，形成柔和的冷暖对比，整体色彩浓郁醇厚，既有沉静的复古质感，又兼具花卉的鲜活明亮感，色彩情绪舒展有活力。

- **主体动作**
画面主体为自然生长状态的花束，无人物、动物或拟人化动作；花朵呈现舒展的生长姿态，包含完全盛放、半开、待放花苞的不同状态，花茎自然弯曲向上伸展，搭配飞溅的色点笔触带有轻盈的灵动感；整体为静态生长状态，无强烈的速度感或夸张动态，传递出自然舒展的生长动势。

- **材质 / 笔触**
采用油画/丙烯厚涂的艺术表现手法，有明显的颜料堆叠形成的凹凸肌理感，可见奔放写意的画笔、刮刀运笔痕迹；画面基底带有粗纹画布的颗粒质感，同时搭配甩笔形成的飞溅色点、干笔扫过的拉丝纹理，笔触松弛写意，质感厚重有层次，无平滑的数码平涂感，手绘艺术感强烈。

- **背景**
背景为统一的深墨绿色粗肌理平面，无具体的写实场景元素，仅带有细微的画布纹理与自然晕开的笔触痕迹；背景整体做虚化弱化处理，与前景厚涂的实感花卉形成明确的虚实层次，空间简洁干净；顶部、底部的背景区域可承载排版内容，边缘有飞溅的色点作为前景与背景的自然过渡，无多余杂乱装饰元素。

- **氛围 / 情绪**
整体氛围文艺松弛，沉静的底色中包裹着鲜活蓬勃的生命力；热烈舒展的花卉传递出自由舒展、积极明亮的情绪，深绿色基底带来安定沉稳的心理感受，整体治愈且带有温和的力量感，艺术氛围浓厚，无喧闹、压抑的负面感受，适配治愈向、励志向的艺术装饰场景。

- **反推提示词**
竖版2:3比例，厚涂油画风格艺术海报底图，粗纹亚麻画布质感，奔放写意的丙烯厚涂笔触，明显的颜料堆叠凹凸肌理，搭配甩笔形成的自然飞溅色点、干笔拉丝纹理；画面中下部为自然舒展的花束，包含盛放的橙红色花朵、奶白色花朵、明黄色花朵与深墨绿色枝叶，点缀不同生长阶段的花苞，花茎自然弯曲向上伸展；背景为沉稳的暗墨绿色纯色肌理底，采用上虚下实的稳定构图，柔和正面漫射光影，明暗过渡自然，低饱和深绿背景衬托中高饱和的暖调花卉，冷暖对比柔和，色彩浓郁醇厚；整体氛围文艺治愈，充满鲜活生命力，画面上下边缘预留充足排版空间，手绘艺术感强烈，高清细腻，8K画质。

- **负面提示词**
摄影实拍效果，3D建模质感，平滑数码平涂感，笔触杂乱僵硬，出现人物、动物元素，复杂写实背景场景，强烈硬光与硬边阴影，画面过曝、大面积死黑，色彩艳俗刺眼，花卉结构畸形错乱，主体过度挤占排版区域，画面模糊低清，生成扭曲乱码文字，多余杂乱装饰元素，压抑沉闷氛围，水印，多余边框。

"#;
const CAPTION_SHEEP: &str = r#"
- **类型**
平面数字创意插画，属于节日主题的视觉设计作品，非纪实摄影作品，非3D写实渲染作品。

- **ratio**
9:16竖屏比例，为适配移动端展示的竖幅尺寸。

- **构图**
竖幅平衡式构图，采用柔化轮廓的创意表现手法，带弯角的羊类头部形象作为核心视觉元素占据画面中左至中心区域，头部朝向画面右下方，节日主题文字放置在画面正中心的视觉重心位置，画面上下及右侧区域留有充足柔和留白，无强烈透视与夸张动势，为中视距平面呈现，整体视觉舒展稳定。

- **光影**
无明确实体光源，呈现均匀柔和的漫射弥散光效，无强烈明暗对比，无锐利阴影与硬边高光，整体曝光柔和适中，无过曝或纯黑死区，光感过渡自然顺滑。

- **色调**
整体为统一暖色调，主色为渐变过渡的正红色、暖橙色，以浅桃粉色、米白色作为基底辅色，色彩饱和度中等偏高，经柔化处理后温和不刺眼，无冷色形成色彩冲突，整体色彩倾向热烈温暖。

- **主体动作**
核心主体为羊类头部形象，呈静态展示状态，头部自然朝向画面右下方，无剧烈动态表现，无速度感，姿态平稳舒展，作为装饰性节日视觉符号存在。

- **材质 / 笔触**
整体为平滑的数字弥散渐变质感，无明确手绘笔触，无硬质轮廓线，所有色块边缘均做高斯模糊式的柔化晕染处理，画面无粗糙颗粒、无凹凸实体纹理，视觉触感顺滑柔和，类似毛玻璃阻隔下的柔化影像效果。

- **背景**
背景为浅暖桃色向米白色过渡的均匀柔和渐变，无具体实景内容，无多余装饰图案，背景与主体色块自然晕染衔接，无明确的前后景硬边界，空间层次平缓简洁。

- **氛围 / 情绪**
整体氛围温暖喜庆、雅致柔和，传递出传统新年的吉祥祝福感，无繁杂喧闹的元素，简约的设计带来舒适治愈的心理感受，兼具节日的热烈氛围与设计的高级感，给人安稳、和煦、吉利的情绪体验。

- **反推提示词**
9:16竖版平面数字插画，新年节日主题，弥散渐变创意设计风格，柔化模糊的带弯角羊头轮廓作为核心视觉元素，羊头朝向画面右下方，节日主题文字置于画面正中心位置，柔和漫射光效无硬边阴影，统一暖色调，正红色、暖橙色自然柔和渐变，搭配浅桃色、米白色柔和基底，无明确笔触无硬质轮廓，所有色块边缘做高斯模糊柔化晕染处理，背景为简洁浅暖渐变无多余装饰元素，整体氛围温暖喜庆雅致柔和，简约高级的节日平面设计，构图平衡舒展，留有充足柔和留白，视觉顺滑舒适。

- **负面提示词**
锐利硬边轮廓，生硬明确线条，突兀手绘笔触，粗糙颗粒纹理，冷色调杂色，强烈明暗对比，生硬块状阴影，繁杂冗余装饰元素，写实摄影效果，3D建模质感，夸张扭曲变形，艳俗刺眼高饱和色彩，文字错乱变形，多余实景景物，过曝或纯黑死区，拥挤闭塞构图。

"#;
const CAPTION_COLLAGE: &str = r#"
- **类型**
混合媒介复古拼贴艺术，属于平面拼贴插画创作范畴，非摄影作品、非3D渲染类作品。

- **ratio**
竖版画幅，画面宽高比约为2:3。

- **构图**
采用中景镜头，完整呈现人物全身姿态；男性主体位于画面视觉核心位置，呈侧面朝向画面右侧，人物自带贴纸白边轮廓，形成从左向右的行走动势，引导视线向画面右侧延伸；各类拼贴元素错落叠压在人物周围，排布疏密有致，无过度拥挤感，元素间叠压关系自然，整体视觉重心稳定。

- **光影**
主体人物采用硬朗的侧光塑造，明暗对比强烈，阴影轮廓清晰锐利，契合老印刷品的光影特征；整体拼贴画面无强烈的全局统一光源，仅模拟纸张叠压产生的微弱自然投影，整体曝光均匀，主体通过强烈的明暗差从背景中凸显，无明显发光边缘效果。

- **色调**
整体以低饱和度暖调为核心基调，主色为旧纸张的米黄色、牛皮纸棕褐色，辅以黑色表现人物轮廓、手写字迹与印刷标识，点缀少量低饱和度的红色、蓝色作为小面积装饰色；整体色彩柔和做旧，暖调占据绝对主导，传递出陈旧复古的色彩情绪。

- **主体动作**
主体为佩戴眼镜的男性，身着西装、背负双肩包，双手插在衣袋中，呈侧身朝向画面右侧的行走姿态；双腿前后分开呈迈步状态，重心向前移动，步幅舒展自然，动作从容放松，带有平稳向前的行进速度感。

- **材质 / 笔触**
融合多种材质质感表现，包含粗糙的牛皮纸、带书写纹理的旧信纸、挺括的邮票与信封纸、金属回形针等不同材质的触感特征；所有纸张元素带有自然的撕纸毛边、旧物磨损痕迹与纸张纤维纹理；人物部分呈现类似老报纸印刷的网点、铜版画排线质感，轮廓为清晰的剪纸硬边并带有贴纸留白边；手写字迹保留自然的钢笔书写笔触，整体纹理丰富，做旧感强烈，元素边缘清晰无过度模糊。

- **背景**
无写实的空间场景作为背景，由各类复古旧物元素错落叠压构成，包含旧邮票、金属回形针、带手写字迹的旧信纸、邮戳、条形码、航空信封、旧单据、不规则撕边碎纸等元素；元素之间通过叠压形成丰富的纸张层次，主体人物位于视觉最上层、突出度最高，背景元素清晰度均匀，无明显虚化处理，整体围绕人物排布，充满旧文书、旧邮件类物件的复古装饰感。

- **氛围 / 情绪**
整体氛围复古怀旧，带有岁月沉淀的文艺叙事感，情绪沉静笃定，传递出从容向前、奔赴前路的内敛力量；旧纸张、老邮件类元素带来温暖的岁月质感，能唤起关于远行、理想、旧时光的联想，氛围感厚重而有温度。

- **反推提示词**
复古混合媒介拼贴艺术，竖版2:3画幅，中景镜头，视觉核心为侧身朝右行走的戴眼镜西装男性，背负双肩包，双手插兜，呈迈步向前的从容姿态；人物为老报纸印刷质感的剪纸贴纸效果，带有白色轮廓边，位于画面最上层；背景由错落叠压的旧牛皮纸、横格旧信纸、旧邮票、航空信封、金属回形针、手写钢笔字迹、邮戳、条形码、撕边碎纸构成，纸张带有自然磨损痕迹、纤维纹理与撕纸毛边；整体为低饱和暖米棕色调，人物采用硬朗侧光形成强烈明暗对比，全局光影柔和，模拟纸张叠压的微弱投影，充满做旧颗粒纹理，排版疏密有致，怀旧文艺氛围浓厚，带有岁月叙事感。

- **负面提示词**
摄影作品，3D渲染，高饱和度鲜艳色彩，过度光滑的数码质感，模糊柔化的边缘，人物肢体畸形、残缺，崭新无痕迹的光滑纸张，杂乱拥挤的排版，过曝或欠曝，强烈眩光特效，卡通二次元风格，扭曲错乱的文字，水印logo，现代感数码元素，塑料质感，大面积脏乱污渍。

"#;
const CAPTION_CAMPER: &str = r#"
- **类型**
3D数字渲染作品，软质卡通微缩模型风格的创意场景插画，采用类似软陶手办的柔边3D建模表现形式，非实拍摄影作品。

- **ratio**
竖版画幅，画面比例为9:16，为适配移动端竖屏展示的比例。

- **构图**
竖幅构图，采用对称式框景结构，左右两棵棕榈树形成自然视觉引导，将观众视线汇聚到画面中下区域的核心主体上；核心主体房车位于画面垂直方向的中下黄金分割位置，上方预留充足天空区域承载装饰图形与文字元素，下方预留水面区域平衡画面重量；镜头为平视带轻微俯角的中景拍摄距离，整体布局均衡稳定，留白舒展，视觉重心清晰落在亮着暖光的房车位置，无拥挤杂乱感。

- **光影**
采用柔和的漫射自然光作为主光源，光线方向为正面偏上，无生硬锐利的阴影边界，阴影边缘柔和弥散；房车内部有暖黄色的人工内透光，从敞开的车门、侧窗、向外翻开的遮阳餐台位置漫溢出来，和外部冷调自然光形成柔和的冷暖光对比；整体曝光均匀明亮，高光温润不刺眼，暗部无死黑区域，光线质感清透柔软。

- **色调**
整体为低饱和度马卡龙清新配色，主色调为柔和的浅天蓝色，搭配奶白色、浅薄荷蓝、暖米黄色、浅豆绿色、浅棕褐色作为辅助色；色彩冷暖平衡，以冷调的蓝、绿色系营造海滨清爽感，用暖黄色的车内灯光、浅米色沙滩中和冷调，整体色彩柔和统一，无高饱和度刺眼色块，视觉感受舒适放松。

- **主体动作**
核心主体拖挂房车为静止停靠休憩的状态，车门向外敞开，两级小型登车梯搭在车门下方的沙地上，侧边带条纹遮阳篷的窗板向外翻开形成外置操作餐台，车内透出暖光，无行驶动势；画面上方的海鸟呈缓慢滑翔的姿态，整体动势平缓松弛，无强烈速度感与冲突感。

- **材质 / 笔触**
整体为软质3D建模质感，所有物体边缘都做了圆角柔化处理，无尖锐棱角；物体表面呈现细腻温润的哑光质感，类似软陶/树脂微缩手办的材质触感，无强烈镜面反光，无明显手绘笔触痕迹；沙地质感细腻松散，水面呈现柔和的半通透柔光反射，整体材质触感软糯柔和。

- **背景**
背景层次从远到近清晰分层，最远层是纯净无云的浅天蓝色天空，天空区域搭配简约白色线描海浪图形、滑翔的卡通海鸟与简洁的装饰文字；中景层是左右对称分布的两棵卡通棕榈树，树下点缀低矮的细叶小草丛；中前景是一小块凸起的米黄色细沙小岛，作为房车的停靠承载区域，沙面上散落白色小贝壳、迷你白色小边几与小型盆栽；最近层是平静柔和的浅蓝色浅水面，托住中间的沙岛；整体背景元素简洁克制，无冗余杂乱细节，和主体软萌可爱的风格高度统一。

- **氛围 / 情绪**
整体氛围松弛治愈，充满夏日海滨度假的悠闲感，传递出宁静、惬意、无压力的情绪，能让人联想到吹着海风、在海边露营旅居的松弛假日，心理感受柔软温暖、清爽舒适，有强烈的治愈感，唤起人们对慢节奏休闲生活的向往。

- **反推提示词**
Blender软质3D渲染，C4D风格，微缩模型场景，软陶哑光质感，9:16竖幅，低饱和马卡龙配色，柔和漫射自然光，软阴影，所有物体边缘圆角柔化；画面中心是停在迷你沙滩小岛上的白蓝拼色复古拖挂小房车，房车车门敞开，灰色小登车梯搭在沙地上，侧边翻开带蓝白条纹遮阳篷的外置小餐台，车内透出暖黄色柔光；房车左右对称分布两棵卡通棕榈树，沙地上散落白色小贝壳、迷你白色小边几、小盆栽和低矮细叶小草，沙滩下方是平静的浅蓝色浅水面；天空中有两只展翅滑翔的白色海鸥，上方搭配简约白色线条绘制的海浪简笔装饰与手写风格"sea breeze"文字；构图均衡对称，留白舒展，清新治愈的海边度假氛围，软糯可爱，视觉柔和舒适。

- **负面提示词**
写实摄影风格，尖锐棱角，高饱和度刺眼色彩，生硬锐利阴影，粗糙凹凸纹理，杂乱冗余元素，出现人物，物体破损、污渍，强烈镜面反光，画面过曝，暗部死黑，物体变形、比例失调，复杂繁琐细节，压抑恐怖情绪，错乱文字，水印，logo，粗糙低质量建模，锐利边缘，颗粒噪点过重。

"#;
const CAPTION_CAT: &str = r#"
- **类型**
写实类实拍宠物自然摄影，属于真实拍摄的摄影作品，画面符合真实世界的物理细节与自然光影逻辑，非绘画、插画或3D渲染类创作。

- **ratio**
竖版画幅，画面宽高比为2:3，适配竖屏观看场景。

- **构图**
采用低角度仰拍的中近景构图，橘白猫咪作为核心主体位于画面中下部偏左位置，猫咪视线朝向画面右上方垂挂的石榴，形成自然的向上视觉引导；粗壮的石榴树枝干斜向贯穿画面下部，作为承载猫咪的结构线；右上方垂挂的石榴果实与猫咪视线形成呼应关系；纯净的蓝天背景留出充足留白，画面元素排布平衡稳定，视觉焦点清晰，镜头距离适中，完整呈现猫咪上半身与枝头果实的互动关系。

- **光影**
以晴朗白日的自然直射阳光作为主光源，光线来自侧上方，属于明亮的硬调日光；高光清晰落在石榴光滑表皮、猫咪毛发受光面、叶片向阳面，呈现自然的光泽感；阴影轮廓利落分明，分布在树干背光处、猫咪身体的背光区域，明暗对比明快通透；整体曝光准确，光线给物体边缘带来柔和的轮廓提亮，没有过曝或死黑区域，光影质感真实自然。

- **色调**
整体色彩鲜亮明快，饱和度适中偏高；以深邃纯净的蔚蓝色为冷调基底，搭配暖橘与白色相间的猫咪毛发、艳红带褐调的石榴果实、深褐灰色的树干、翠绿色的叶片作为主要色彩；冷暖对比清晰，蓝天的冷色有效衬托猫咪、石榴的暖调色彩，整体色彩通透干净，传递出晴日户外鲜活的视觉感受。

- **主体动作**
核心主体橘白猫咪端正蹲坐于石榴树的粗枝分叉处，两只前爪自然搭在身前的横枝上，头部向上仰起，视线专注投向面前垂挂的石榴果实，呈现出好奇观察的静态姿态；带有环状橘白纹路的尾巴自然下垂，顺着树干垂向画面下方，整体动作舒缓放松，无剧烈动势，传递出对枝头果实的好奇感。

- **材质 / 笔触**
为实拍影像的真实材质表现，无人工绘画笔触；画面细节锐利清晰，精准呈现不同物体的质感：猫咪毛发蓬松柔软的丝缕纹理、石榴表皮光滑带自然果斑的蜡质质感、树干粗糙带地衣附着的树皮纹理、叶片薄而带叶脉的革质感都真实可辨；整体成像扎实自然，无模糊、涂抹或人工加工的纹理痕迹。

- **背景**
背景层次分明，最远层是晴朗无云的纯净蔚蓝色天空，干净通透；中后层是经自然景深虚化的石榴树翠绿枝叶，点缀零星垂挂的红色石榴果实，形成柔和的绿色虚焦层次；远景虚化有效突出前景的猫咪与近枝石榴，空间纵深感自然，无杂乱冗余元素。

- **氛围 / 情绪**
整体氛围明朗鲜活、松弛治愈，充满晴日户外的蓬勃生机感；猫咪好奇仰头望向石榴的姿态带着天真软萌的童趣，红果、绿叶、蓝天、软萌猫咪的组合传递出闲适宁静的自然野趣，给人岁月静好、轻松舒展的心理感受，无紧张压抑感，满是明亮温暖的日常治愈感。

- **反推提示词**
写实宠物摄影，低角度仰拍，2:3竖幅构图，晴朗白日明亮直射自然日光，一只橘白相间的短毛家猫端正蹲坐于石榴树粗壮的枝桠分叉处，前爪自然搭在身前的横枝上，仰头好奇注视着枝头垂挂的成熟红石榴，猫咪毛发蓬松纹理清晰，石榴表皮光滑带自然红褐色果斑，旁侧环绕翠绿的革质石榴树叶，深褐色树皮粗糙带有零星地衣痕迹，背景是纯净无云的深邃蔚蓝色天空，远景为自然虚化的石榴枝叶与零星红色石榴果实，明暗对比明快通透，色彩鲜亮饱和，冷暖对比清晰，画面细节锐利，自然浅景深，氛围治愈鲜活，充满晴日户外的自然生趣，曝光准确，光影柔和自然。

- **负面提示词**
模糊失焦，画质低劣，颗粒噪点过重，过曝死白，欠曝死黑，猫咪肢体畸形、形态扭曲，果实形态怪异失真，画面元素杂乱冗余，出现多余人物、文字、水印、logo，卡通、插画、手绘、3D渲染风格，人工绘画笔触，色彩灰暗浑浊，光影生硬违和，物体材质质感虚假，动态夸张不自然，边缘抠图痕迹。

"#;
const CAPTION_ZEN: &str = r#"
- **类型**
带有东方美学风格的数字扁平肌理插画，属于静态静物主题创作，非摄影作品、非3D建模作品。

- **ratio**
竖版画幅，画面宽高比约为3:4，适配竖向展示场景。

- **构图**
采用平视角度的中景稳定构图，主体竹制置物架及上面的陈设集中布置在画面下半区域，是画面的视觉重心；纤细的花艺枝条从置物架位置向上自然舒展，打破横向结构的平稳沉闷感；画面上半部分及左右两侧留有大量留白，元素排布疏朗均衡，无强烈透视变形，整体重心平稳，在对称平衡中带有自然植物的错落灵动。

- **光影**
整体为柔和均匀的漫射日间自然光，无明确的强指向性主光源，不存在强烈的明暗反差；仅在置物架底部带有浅淡柔和的投影，无刺眼硬高光、轮廓光或特殊发光效果，整体曝光适中，光线过渡平缓自然。

- **色调**
整体以不同层次的低饱和度绿色为主色调，从背景的浅豆绿到蕨叶的深绿、花器的墨绿形成柔和的色彩递进；辅以浅竹米黄色、花朵的纯白色、花蕊的淡橙色作为点缀；整体饱和度偏低，以冷调绿色为基底，搭配暖调的竹质色彩平衡冷暖关系，无高饱和度的艳丽色块，色彩观感柔和雅致。

- **主体动作**
画面无动态的人物或动物主体，所有陈设元素均处于平稳静置的状态；花艺细枝自然向上舒展，蕨类叶片向两侧柔和伸展开，不存在剧烈动作、速度感或强方向性的动态，整体呈现安静摆放的静态松弛感。

- **材质 / 笔触**
采用平涂填色叠加统一颗粒噪点的数字绘画表现方式，无明显外露的手绘笔触、厚涂堆料肌理或模糊虚焦效果；所有元素的轮廓边缘清晰柔和，画面整体覆盖细腻的颗粒纹理，模拟哑光粗纹纸张的质感，材质表现平滑统一，无强烈的镜面反光效果。

- **背景**
背景为简洁的竖向渐变效果，从上至下由柔和的灰豆绿色逐渐过渡到浅米白色，无具体的场景景物、装饰图案或多余的干扰元素；背景无实体内容，通过干净的渐变衬托前景的陈设主体，空间层次简洁清晰，没有复杂的前后景穿插遮挡。

- **氛围 / 情绪**
整体呈现清雅宁静的东方禅意氛围，情绪舒缓平和，传递出慢生活的闲适、治愈感；带有素雅的东方审美气质，容易让人联想到安静的茶室闲居日常，给人松弛、清爽、平静的心理感受，无强烈的情绪冲击，营造出淡然雅致的静态美感。

- **反推提示词**
扁平肌理风格数字插画，东方禅意静物主题，竖版3:4画幅，平视中景视角，画面下半部分摆放竹制矮置物架，架上放置竹制蒸格、黑色浅碗花器，花器中插有自然舒展的白色细枝小花与蕨类叶片，构图疏朗留有大量留白，柔和均匀的漫射自然光，浅淡柔和的阴影，低饱和度绿色系为主色调，搭配浅竹黄色、纯白色、淡橙色点缀，画面整体覆盖细腻颗粒噪点，带有哑光粗纹纸张质感，背景为从上至下豆绿色渐变到米白色的简洁背景，整体氛围清雅宁静、治愈松弛，呈现东方美学的素雅平衡感，无多余装饰元素，色彩柔和淡雅。

- **负面提示词**
高饱和度艳丽色彩，强烈硬边阴影，刺眼高光与轮廓光，复杂冗余的背景元素，多余的人物、动物形象，夸张透视与形体变形，3D建模质感，超写实摄影风格，粗糙外露的手绘笔触，厚涂油画质感，元素排布杂乱，文字、logo、水印，强反光的金属玻璃材质，剧烈动态效果，主体模糊虚焦，尖锐突兀的轮廓。

"#;
const CAPTION_FASHION: &str = r#"
- **类型**
写实风格的时尚人像摄影，带有精修商业大片质感，整体接近高端棚拍肖像。

- **ratio**
9:16 竖幅比例，适合人物半身特写、手机壁纸和竖屏视觉内容。

- **构图**
正面近距离半身构图，人物居中且占据画面主体，头顶保留少量空间，腰部在画面下缘附近截断。双眼位于视觉焦点区域，直视镜头；抬起的手臂形成纵向引导线，飘动的发丝横穿面部，为稳定的中心构图增加动势与层次。

- **光影**
柔和的正面偏侧光集中照亮面部与上半身，眼睛、鼻梁、嘴唇和首饰处带有清晰高光。背景与头发保持深暗，仅以微弱轮廓光分离边缘；整体曝光偏低但主体细节充足，明暗反差较强，具有低调布光效果。

- **色调**
以黑色、深棕色、灰褐色为主，辅以肤色和银色首饰高光。整体低饱和、偏暖且沉稳，深色背景加强了肤色的柔亮感，营造出克制、成熟的秋冬色彩情绪。

- **主体动作**
人物正面直视镜头，上半身自然挺直，一只手抬至面部并轻轻拉起高领遮住嘴部。头发被微风吹动，几缕发丝掠过眼睛与鼻梁；姿态安静克制，同时带有轻微防御感和神秘感。

- **材质 / 笔触**
画面呈现高清写实摄影质感，皮肤经过细腻柔化但仍保留轻微纹理。罗纹针织面料纹路清晰，皮革下装具有平滑而强烈的反光，长发柔顺且富有光泽，金属首饰呈现细小锐利的高光；整体锐度较高，精修感明显。

- **背景**
纯黑至深灰色的简洁背景，没有明显场景或装饰元素。背景被压暗并轻度虚化，与人物形成强烈明暗分离，使视觉注意力完全集中在面部、眼神和服装材质上。

- **氛围 / 情绪**
冷静、神秘、精致而略带疏离感。直接而锐利的目光形成较强视觉张力，高领遮面和飞扬发丝增添含蓄的叙事感，整体具有成熟、优雅的秋冬时尚氛围。

- **反推提示词**
高端时尚棚拍人像摄影，9:16 竖幅，年轻成年女性，正面半身特写，人物居中，长而浓密的黑色波浪发，几缕发丝被微风吹过面部，深邃双眼直视镜头，精致自然妆容，纤长睫毛，穿灰褐色修身罗纹高领针织衫，一只手轻轻拉起衣领遮住嘴部，搭配简约银色耳饰、项链与戒指，深棕色高腰亮面皮革下装，纯黑背景，低调棚拍布光，柔和正面偏侧光，细腻肤质，清晰织物纹理，皮革反光，浅景深，低饱和暖棕色调，高反差，电影感，优雅神秘，超写实，高细节，商业时尚大片质感。

- **负面提示词**
低清晰度，模糊，噪点过重，过曝，死黑阴影，肤色异常，塑料皮肤，过度磨皮，面部不对称，五官错位，眼神涣散，瞳孔异常，斗鸡眼，畸形手掌，多余手指，缺失手指，手指粘连，手部比例错误，多余肢体，身体扭曲，头发穿模，首饰变形，服装纹理错乱，皮革褶皱异常，背景杂乱，文字，标识，水印，边框，卡通感，油画笔触，低多边形，强烈广角畸变，过度锐化，过饱和。

"#;
const CAPTION_OUTDOOR: &str = r#"
- **类型**
户外人像摄影，偏自然清新的手机自拍风格，画面具有轻度美颜与柔和润饰效果。

- **ratio**
9:16 竖幅比例，适合手机壁纸、社交媒体封面及竖屏人像展示。

- **构图**
胸部以上近景自拍构图，人物居中并直视镜头，脸部位于画面视觉中心。手臂从右下方延伸形成轻微引导线，头顶保留较多环境空间，背景树木呈纵向分布，强化竖幅的延伸感。

- **光影**
温暖柔和的自然光从画面右侧斜向照射，面部曝光明亮均匀，阴影较浅。发丝边缘带有细微暖色轮廓光，背景局部高光明显，但整体动态范围平衡，没有强烈硬阴影。

- **色调**
以天空蓝、森林绿、浅木色和黑色为主，浅蓝服装形成清爽的视觉焦点。整体色彩自然偏暖，饱和度适中，肤色明亮柔和，呈现温暖而通透的户外色彩氛围。

- **主体动作**
人物正面面对镜头，头部保持端正，视线直视观者，嘴角轻微上扬。身体姿态放松，一侧手臂向前伸出完成自拍，动作稳定，没有明显速度感。

- **材质 / 笔触**
高清摄影质感，皮肤细腻平滑，带有轻度柔焦和自然磨皮效果；长发乌黑顺滑，发丝层次清晰。针织内搭、轻薄外衣与小型饰品具有可辨识的材质纹理，背景细节略微柔化。

- **背景**
背景为开阔的林地环境，包括高大常绿树、低矮灌木、木质围栏、草地与浅蓝天空。人物与背景层次明确，但景深较深，树木和围栏仍保留较多细节，营造自然公园或林间步道的空间感。

- **氛围 / 情绪**
整体氛围清新、安静、温柔而亲近，带有晴朗傍晚散步时随手自拍的生活感。人物平和的表情与暖色阳光共同传达放松、自然、轻盈的情绪。

- **反推提示词**
写实户外人像摄影，9:16竖幅，年轻女性正面近景自拍，人物居中，直视镜头，轻柔微笑，长直黑发自然垂落，清透自然妆容，浅蓝色轻薄波点外衣，米色针织内搭，精致小型项链，一侧手臂伸向镜头，森林公园背景，高大常绿树木、木质围栏、草地与晴朗蓝天，温暖傍晚自然光，右侧柔和侧光，细微发丝轮廓光，明亮均匀肤色，清新自然配色，真实摄影质感，细腻皮肤纹理，轻度柔焦，高清细节，舒适宁静的生活化氛围。

- **负面提示词**
低分辨率，明显噪点，过度磨皮，塑料皮肤，蜡像感，强烈滤镜，肤色失真，曝光过度，死黑阴影，强硬顶光，杂乱背景，畸形面部，五官错位，双眼不对称，斜视，僵硬表情，异常牙齿，多余手指，缺失手指，手臂畸形，身体比例错误，发丝粘连，衣物纹理错乱，饰品变形，明显运动模糊，人工描边，卡通感，油画感，三维渲染感，文字，水印，标志，边框。

"#;

/// 首启注入入口：异步、不阻塞启动窗口。双 gate（旗标 + 空库）判定是否注入。
/// 必须在 `app.manage(settings_state)` 之后调用（spawn 内经 `app.state::<SettingsState>()` 读写旗标）。
pub fn seed_if_first_launch(app: AppHandle, db: Arc<Database>, paths: Arc<LibraryPaths>) {
    tauri::async_runtime::spawn(async move {
        let settings_state = app.state::<SettingsState>();

        // gate 1：旗标已写 → 已注入过，跳过。
        if settings_state.inner().get().samples_seeded {
            return;
        }
        // gate 2：库非空 → 用户已有数据（settings 损坏/复制/手动重置 flag），不污染。
        match db_call(&db, |db| db.count_assets(None)).await {
            Ok(n) if n > 0 => return,
            Ok(_) => {}
            Err(e) => {
                tracing::warn!("samples seed: count check failed: {e}");
                return;
            }
        }
        // dev 图未放 / release resource 缺失 → 优雅跳过，不写旗标（下次启动重试）。
        let Some(dir) = resolve_samples_dir(&app) else {
            tracing::warn!("samples resource dir not found, skipping seed");
            return;
        };

        let mut ok = 0usize;
        for spec in SAMPLES {
            let path = dir.join(spec.filename);
            if !path.exists() {
                tracing::warn!("sample missing: {}", path.display());
                continue;
            }
            let path_display = path.display().to_string();
            let db = db.clone();
            let paths = paths.clone();
            let caption_text = spec.caption.to_string();
            let tag_names: Vec<String> = spec.tags.iter().map(|s| s.to_string()).collect();
            match tokio::task::spawn_blocking(move || {
                seed_one(&paths, &db, &path, &caption_text, &tag_names)
            })
            .await
            {
                Ok(Ok(())) => ok += 1,
                Ok(Err(e)) => tracing::warn!("seed_one failed for {path_display}: {e}"),
                Err(e) => tracing::warn!("seed_one panicked for {path_display}: {e}"),
            }
        }

        // 任一成功才写旗标（避免每次启动重跑已注入的）；全失败保持 false 下次重试。
        if ok > 0 {
            // 重读最新设置再合并，最小化 TOCTOU 覆盖用户并发改动。
            let mut latest = settings_state.inner().get();
            latest.samples_seeded = true;
            if let Err(e) = settings_state.inner().update(latest) {
                tracing::warn!("samples_seeded flag persist failed: {e}");
            }
            let _ = app.emit("library://assets-changed", ());
            // 写了 caption 必须再 emit analyses://changed：前端 captionedIds（瀑布流 🏷️ 角标依据）
            // 只在 mount 与 analyses://changed 时重拉（library://assets-changed 的 refresh 不含它），
            // 否则首启注入的 🏷️ 角标会因 mount 时注入未完成而缺失（实测只有 mount 途中已入库的几张显示）。
            let _ = app.emit("analyses://changed", ());
            // 建「欢迎来到园丁鸟」预置项目 + 关联示例图（幂等），作为入门指引载体。
            if let Err(e) = db_call(&db, |db| seed_welcome_project(db)).await {
                tracing::warn!("seed welcome project failed: {e}");
            }
            let _ = app.emit("projects://changed", ());
            tracing::info!("samples seeded: {ok}/{}", SAMPLES.len());
        } else {
            tracing::warn!("samples seeding: 0 succeeded, flag not set (will retry next launch)");
        }
    });
}

/// 注入单张示例图：ingest 入库 → 改 source=sample → 预填 caption + auto tag。
/// 同步函数，须在 `spawn_blocking` 内跑（ingest_file 含 image decode + DB 写）。
fn seed_one(
    paths: &LibraryPaths,
    db: &Database,
    source: &Path,
    caption_text: &str,
    tag_names: &[String],
) -> AppResult<()> {
    // 1) 入库（完整 probe/copy/thumb/pHash/colors/dedup）。ingest_file 硬编码 source="imported"，
    //    仿 ingest_from_bytes 在其后手写 UPDATE 改成 sample。
    let asset = ingest::ingest_file(paths, db, source)?;
    {
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "UPDATE assets SET source=?1 WHERE id=?2",
            rusqlite::params![SAMPLE_SOURCE, asset.id],
        )?;
    }
    // 主色：ingest_file 内部已调 link_colors，无需额外处理。

    // 2) caption 预填：不调 codex，纯文本 parse + build_payload + insert。
    //    phash dedup 命中已存 sample 时跳过，避免重复 caption 行。
    if db.has_analysis(&asset.id, "caption")? {
        return Ok(());
    }
    let analysis = caption::parse(caption_text);
    let payload = caption::build_payload(
        caption_text,
        SEED_INSTRUCTION,
        None,
        SAMPLE_SOURCE,
        &analysis,
    );
    let row = Analysis {
        id: ulid::Ulid::new().to_string(),
        asset_id: asset.id.clone(),
        kind: "caption".to_string(),
        payload,
        provider: Some(SAMPLE_SOURCE.to_string()),
        created_at: None,
    };
    db.insert_analysis(&row)?;

    // 3) auto tag：用名字（不硬编码 seed id），get_or_create_tag 幂等命中已 seed 的固定 id。
    let tag_ids: Vec<String> = tag_names
        .iter()
        .filter_map(|n| db.get_or_create_tag(n, "auto").ok())
        .collect();
    if !tag_ids.is_empty() {
        db.set_asset_tags(&asset.id, &tag_ids, "auto")?;
    }

    Ok(())
}

/// 解析示例图目录：dev 走源码 `src-tauri/resources/samples`，release 走 resource_dir/samples。
/// 抄 commands/collect.rs::extension_folder_path 的双分支范式。
pub(crate) fn resolve_samples_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = if cfg!(debug_assertions) {
        // CARGO_MANIFEST_DIR = .../apps/desktop/src-tauri
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("samples")
    } else {
        app.path().resource_dir().ok()?.join("samples")
    };
    dir.is_dir().then_some(dir)
}

/// 在 spawn_blocking 里跑一次 DB 调用（ingest/DB 操作是同步阻塞的）。
/// 抄 core/autoname.rs::db_call 范式。
async fn db_call<T, F>(db: &Arc<Database>, f: F) -> Result<T, String>
where
    F: FnOnce(&Arc<Database>) -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    let db = db.clone();
    tokio::task::spawn_blocking(move || f(&db))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// 预置项目固定 id。「欢迎来到园丁鸟」装 8 张示例图，作为入门指引载体。
const WELCOME_PROJECT_ID: &str = "builtin:welcome";

/// 建「欢迎来到园丁鸟」预置项目（固定 id，幂等）+ 关联全部 source='sample' 资产。
/// workspace_path 用虚拟值（无真实目录；delete_project 对 kind='builtin' 强制 Keep，不会 MoveOut）。
fn seed_welcome_project(db: &Database) -> AppResult<()> {
    let exists: bool = db.conn.lock().unwrap().query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
        rusqlite::params![WELCOME_PROJECT_ID],
        |r| r.get(0),
    )?;
    if !exists {
        db.create_project(
            WELCOME_PROJECT_ID,
            "欢迎来到园丁鸟",
            "builtin:welcome",
            WELCOME_PROJECT_ID,
            "builtin",
        )?;
    }
    // 关联全部示例资产（首启空库，注入的就是全部 source='sample'）。
    let ids: Vec<String> = {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM assets WHERE source = 'sample'")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut v = Vec::new();
        for r in rows {
            v.push(r?);
        }
        v
    };
    if !ids.is_empty() {
        db.add_assets_to_project(WELCOME_PROJECT_ID, &ids)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::paths::LibraryPaths;
    use crate::db::Database;
    use crate::media::phash::testutil::make_photo_file;
    use std::path::PathBuf;
    use ulid::Ulid;

    struct Tmp {
        dir: PathBuf,
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn setup() -> (Tmp, LibraryPaths, Database) {
        let dir = std::env::temp_dir().join(format!("bb-samples-{}", Ulid::new()));
        std::fs::create_dir_all(&dir).unwrap();
        let paths = LibraryPaths::init(dir.clone()).unwrap();
        let db = Database::open_in_memory().unwrap();
        db.migrate().unwrap();
        (Tmp { dir }, paths, db)
    }

    #[test]
    fn caption_manifest_parses_as_structured() {
        // 每张示例图的 caption 都应解析为 parse_status="structured"
        // （即 5 个标准维度 composition/light/palette/action/mood 全部映射成功）。
        for spec in SAMPLES {
            let a = caption::parse(spec.caption);
            assert_eq!(
                a.parse_status, "structured",
                "caption for {} did not parse as structured: dims = {:?}",
                spec.filename, a.dimensions
            );
            for key in caption::DIMENSION_KEYS {
                assert!(
                    a.dimensions.contains_key(key),
                    "{} missing dimension {key}",
                    spec.filename
                );
            }
        }
    }

    #[test]
    fn tags_are_in_seed_vocab() {
        // 校验所有 SampleSpec.tags 都在 0005 seed 词表内（防侧栏词表意外膨胀）。
        let vocab = [
            "人像", "风景", "静物", "美食", "动物", "建筑", "抽象", "插画", "室内", "街景",
        ];
        for spec in SAMPLES {
            for t in spec.tags {
                assert!(vocab.contains(t), "tag {t} not in seed vocab",);
            }
        }
    }

    #[test]
    fn seed_one_end_to_end_and_idempotent() {
        let (tmp, paths, db) = setup();
        // make_photo_file 造高熵照片级图（确保能被 find_asset_by_phash dedup）。name 须带扩展名。
        let img = make_photo_file(&tmp.dir, "portrait.png", 256, 7);

        let tags = vec!["人像".to_string()];
        seed_one(&paths, &db, &img, CAPTION_FASHION, &tags).unwrap();

        // 校验入库 + source=sample + caption + auto tag。
        assert_eq!(db.count_assets(None).unwrap(), 1);
        let id: String = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT id FROM assets WHERE source='sample'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(db.has_analysis(&id, "caption").unwrap());
        assert!(db.has_auto_tag(&id).unwrap());

        // 再次 seed 同图：phash dedup 命中已存 sample + has_analysis 跳过 → 不产生重复 caption。
        seed_one(&paths, &db, &img, CAPTION_FASHION, &tags).unwrap();
        assert_eq!(db.count_assets(None).unwrap(), 1);
        let caption_count: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM analyses WHERE asset_id=?1 AND kind='caption'",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(caption_count, 1, "重复 seed 不应新增 caption 行");
    }
}

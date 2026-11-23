const {Client,GatewayIntentBits,Partials,ChannelType,EmbedBuilder,ActionRowBuilder,StringSelectMenuBuilder,ChannelSelectMenuBuilder}=require("discord.js");
const {joinVoiceChannel,getVoiceConnection}=require("@discordjs/voice");
const fs=require("fs"),path=require("path");
const TOKEN=process.env.DISCORD_TOKEN;
const ROLE_IDS=(process.env.ADMIN_ROLE_IDS||"").split(",").map(x=>x.trim()).filter(Boolean);
if(!TOKEN){console.error("Missing DISCORD_TOKEN");process.exit(1);}
const DATA=path.join(__dirname,"data"),FILE=path.join(DATA,"settings.json");
fs.mkdirSync(DATA,{recursive:true});
let settings={logs:{},shortcuts:{}};
try{settings=JSON.parse(fs.readFileSync(FILE,"utf8"));}catch{}
function save(){fs.writeFileSync(FILE,JSON.stringify(settings,null,2));}
function high(member){return !!member&&ROLE_IDS.length>0&&member.roles.cache.some(r=>ROLE_IDS.includes(r.id));}
const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent,GatewayIntentBits.GuildVoiceStates,GatewayIntentBits.GuildModeration],partials:[Partials.Message,Partials.Channel,Partials.User,Partials.GuildMember]});
const TYPES=[["ticket","لوق التكتات"],["messages","لوق الرسائل"],["members","لوق دخول وخروج"],["voice","لوق الصوتيات"],["actions","لوق الإجراءات"],["channels","لوق الرومات"],["roles","لوق الرتب"]];
const label=u=>u?u.tag+" ("+u.id+")":"عضو غير معروف";
async function log(guild,type,title,desc){const id=settings.logs[guild.id]?.[type];if(!id)return;const ch=await guild.channels.fetch(id).catch(()=>null);if(ch&&ch.isTextBased())ch.send({embeds:[new EmbedBuilder().setColor(0x648cff).setTitle(title).setDescription(String(desc||"—").slice(0,4000)).setTimestamp()]}).catch(()=>{});}
function duration(s){const m=/^(\d+)(s|m|h|d)$/i.exec(s||"");if(!m)return null;const n=+m[1];if(!n||n>40320)return null;return n*({s:1000,m:60000,h:3600000,d:86400000})[m[2].toLowerCase()];}
client.once("ready",()=>{console.log("NEXO bot online as "+client.user.tag);if(!ROLE_IDS.length)console.warn("Set ADMIN_ROLE_IDS with high-rank role IDs.");});
client.on("messageCreate",async m=>{
 if(!m.guild||m.author.bot)return;
 const c=m.content.trim(),p=c.split(/\s+/),cmd=p[0];
 const shortcuts=settings.shortcuts[m.guild.id]||{};
 if(shortcuts[c])return m.reply(shortcuts[c]).catch(()=>{});
 if(cmd==="دخول"){const v=m.member.voice.channel;if(!v)return m.reply("خش للروم الصوتي الأول.");try{joinVoiceChannel({channelId:v.id,guildId:m.guild.id,adapterCreator:m.guild.voiceAdapterCreator,selfDeaf:true});return m.reply("دخلت معاك للروم: "+v.name);}catch{return m.reply("ما قدرتش ندخل للروم الصوتي.");}}
 if(cmd==="خروج"){const v=getVoiceConnection(m.guild.id);if(!v)return m.reply("مش داخل في روم صوتي.");v.destroy();return m.reply("طلعت من الروم الصوتي.");}
 const admin=["تف","ق","ف","م","اسكت","لوقات","اختصار"];
 if(!admin.includes(cmd)&&!c.startsWith("فك تايم")&&!c.startsWith("فك باند"))return;
 if(!high(m.member))return m.reply("الأمر هذا للرتب العليا المسموح بها فقط.");
 if(!ROLE_IDS.length)return m.reply("اضبط ADMIN_ROLE_IDS في إعدادات الاستضافة بمعرّفات الرتب العليا.");
 if(cmd==="تف"){const t=m.mentions.members.first();if(!t)return m.reply("استعمال الأمر: تف @العضو [السبب]");if(!t.bannable)return m.reply("ما نقدرش نحظر العضو؛ راجع صلاحيات البوت وترتيب الرتب.");return t.ban({reason:p.slice(2).join(" ")||"بواسطة "+m.author.tag}).then(()=>m.reply("تم حظر "+t.user.tag+".")).catch(()=>m.reply("فشل الحظر."));}
 if(cmd==="ق"||cmd==="ف"){const ch=m.mentions.channels.first()||m.channel;return ch.permissionOverwrites.edit(m.guild.roles.everyone,{SendMessages:cmd==="ق"?false:null}).then(()=>m.reply(cmd==="ق"?"تم قفل الروم.":"تم فتح الروم.")).catch(()=>m.reply("فشل تعديل صلاحيات الروم."));}
 if(cmd==="م"){const n=Number(p[1]||10);if(!Number.isInteger(n)||n<1||n>100)return m.reply("اكتب عدد من 1 إلى 100. مثال: م 20");const d=await m.channel.bulkDelete(n,true).catch(()=>null);if(!d)return m.reply("فشل المسح؛ الرسائل الأقدم من 14 يوم لا تنمسح جماعياً.");const x=await m.channel.send("تم مسح "+d.size+" رسالة.").catch(()=>null);if(x)setTimeout(()=>x.delete().catch(()=>{}),4000);return;}
 if(cmd==="اسكت"){const t=m.mentions.members.first(),ms=duration(p[2]);if(!t||!ms)return m.reply("استعمال الأمر: اسكت @العضو 10m [السبب]");return t.timeout(ms,p.slice(3).join(" ")||"بواسطة "+m.author.tag).then(()=>m.reply("تم إسكات "+t.user.tag+".")).catch(()=>m.reply("فشل الإسكات."));}
 if(c.startsWith("فك تايم")){const t=m.mentions.members.first();if(!t)return m.reply("استعمال الأمر: فك تايم @العضو");return t.timeout(null,"إزالة الإسكات بواسطة "+m.author.tag).then(()=>m.reply("تم فك الإسكات.")).catch(()=>m.reply("فشل فك الإسكات."));}
 if(c.startsWith("فك باند")){const id=p[2]||p[1];if(!/^\d{17,20}$/.test(id||""))return m.reply("استعمال الأمر: فك باند ID");return m.guild.members.unban(id).then(()=>m.reply("تم فك الحظر.")).catch(()=>m.reply("ما قدرتش نفك الحظر؛ تأكد من ID."));}
 if(cmd==="لوقات"){const menu=new StringSelectMenuBuilder().setCustomId("logs:type").setPlaceholder("اختار نوع اللوق").addOptions(TYPES.map(x=>({label:x[1],value:x[0]})));return m.reply({content:"اختار نوع اللوق، وبعدها اختار الروم:",components:[new ActionRowBuilder().addComponents(menu)]});}
 if(cmd==="اختصار"){const sub=p[1];if(sub==="إضافة"){const a=c.slice("اختصار إضافة".length).trim().split("|");if(a.length<2||!a[0].trim()||!a.slice(1).join("|").trim())return m.reply("استعمال: اختصار إضافة الكلمة | الرد");settings.shortcuts[m.guild.id]||={};settings.shortcuts[m.guild.id][a[0].trim()]=a.slice(1).join("|").trim();save();return m.reply("تم حفظ الاختصار.");}if(sub==="حذف"){const k=p.slice(2).join(" ");if(!shortcuts[k])return m.reply("الاختصار مش موجود.");delete shortcuts[k];save();return m.reply("تم حذف الاختصار.");}if(sub==="قائمة"){const a=Object.entries(shortcuts);return m.reply(a.length?a.map(x=>"**"+x[0]+"** ← "+x[1]).join("\n").slice(0,1900):"ما فيش اختصارات.");}return m.reply("الأوامر: اختصار إضافة الكلمة | الرد — اختصار حذف الكلمة — اختصار قائمة");}
});
client.on("interactionCreate",async i=>{
 if(!i.guild||(!i.isStringSelectMenu()&&!i.isChannelSelectMenu()))return;
 if(!high(i.member))return i.reply({content:"إعداد اللوقات للرتب العليا فقط.",ephemeral:true}).catch(()=>{});
 if(i.customId==="logs:type"){const type=i.values[0],menu=new ChannelSelectMenuBuilder().setCustomId("logs:channel:"+type).setPlaceholder("اختار روم اللوقات").setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1);return i.reply({content:"اختار الروم:",components:[new ActionRowBuilder().addComponents(menu)],ephemeral:true});}
 if(i.customId.startsWith("logs:channel:")){const type=i.customId.split(":")[2],id=i.values[0];settings.logs[i.guild.id]||={};settings.logs[i.guild.id][type]=id;save();return i.update({content:"تم ربط "+(TYPES.find(x=>x[0]===type)?.[1]||type)+" بالروم <#"+id+">.",components:[]});}
});
client.on("messageDelete",m=>{if(m.guild)log(m.guild,"messages","حذف رسالة","الكاتب: "+label(m.author)+"\nالروم: <#"+m.channelId+">\nالمحتوى: "+(m.content||"غير متوفر").slice(0,1500));});
client.on("messageUpdate",(a,b)=>{if(b.guild&&a.content!==b.content)log(b.guild,"messages","تعديل رسالة","الكاتب: "+label(b.author)+"\nالروم: <#"+b.channelId+">\nقبل: "+(a.content||"غير متوفر").slice(0,700)+"\nبعد: "+(b.content||"غير متوفر").slice(0,700));});
client.on("guildMemberAdd",m=>log(m.guild,"members","دخول عضو",label(m.user)+" دخل السيرفر."));
client.on("guildMemberRemove",m=>log(m.guild,"members","خروج عضو",label(m.user)+" خرج من السيرفر."));
client.on("voiceStateUpdate",(a,b)=>{if(a.channelId===b.channelId)return;const m=b.member||a.member,g=b.guild||a.guild,what=!a.channelId?"دخل":!b.channelId?"طلع من":"انتقل من",where=!a.channelId?"<#"+b.channelId+">":!b.channelId?"<#"+a.channelId+">":"<#"+a.channelId+"> إلى <#"+b.channelId+">";log(g,"voice","تغيير صوتي",label(m?.user)+" "+what+" "+where+".");});
client.on("channelCreate",c=>{if(c.guild)log(c.guild,"channels","إنشاء روم",c.name+" ("+c.id+")");});
client.on("channelDelete",c=>{if(c.guild)log(c.guild,"channels","حذف روم",c.name+" ("+c.id+")");});
client.on("roleDelete",r=>log(r.guild,"roles","حذف رتبة","تم حذف "+r.name+" ("+r.id+")"));
client.on("guildMemberUpdate",(a,b)=>{const added=b.roles.cache.filter(r=>!a.roles.cache.has(r.id));if(added.size)log(b.guild,"actions","إعطاء رتبة",label(b.user)+" أخذ: "+added.map(r=>r.name).join("، "));});
client.on("channelUpdate",(a,b)=>{if(!b.guild)return;const id=b.guild.roles.everyone.id,old=a.permissionOverwrites?.cache.get(id),now=b.permissionOverwrites?.cache.get(id);if(old?.deny.has("SendMessages")!==now?.deny.has("SendMessages"))log(b.guild,"ticket","قفل/فتح روم","الروم: <#"+b.id+">");});
client.login(TOKEN).catch(e=>{console.error("Discord login failed:",e.message);process.exit(1);});

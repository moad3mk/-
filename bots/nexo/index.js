const {Client,GatewayIntentBits,Partials,ChannelType,EmbedBuilder,ActionRowBuilder,StringSelectMenuBuilder,ChannelSelectMenuBuilder,RoleSelectMenuBuilder,UserSelectMenuBuilder,ModalBuilder,TextInputBuilder,TextInputStyle,SlashCommandBuilder,REST,Routes}=require("discord.js");
const {joinVoiceChannel,getVoiceConnection}=require("@discordjs/voice");
const fs=require("fs"),path=require("path");
const TOKEN=process.env.DISCORD_TOKEN;
const ROLE_IDS=(process.env.ADMIN_ROLE_IDS||"").split(",").map(x=>x.trim()).filter(Boolean);
if(!TOKEN){console.error("Missing DISCORD_TOKEN");process.exit(1);}
const DATA=path.join(__dirname,"data"),FILE=path.join(DATA,"settings.json");
fs.mkdirSync(DATA,{recursive:true});
let settings={logs:{},shortcuts:{},permissions:{}};
const dmSessions=new Map();
try{settings=JSON.parse(fs.readFileSync(FILE,"utf8"));}catch{}
settings.logs ||= {}; settings.shortcuts ||= {}; settings.permissions ||= {};
function save(){fs.writeFileSync(FILE,JSON.stringify(settings,null,2));}
function high(member,guild,permissions){return !!member&&(member.id===guild?.ownerId||!!permissions?.has?.("Administrator")||!!permissions?.has?.("ManageGuild")||!!member.permissions?.has?.("Administrator")||!!member.permissions?.has?.("ManageGuild")||!!member.roles?.cache?.some(r=>ROLE_IDS.includes(r.id)));}
function canCommand(member,guild,command,permissions){if(high(member,guild,permissions))return true;const p=settings.permissions?.[guild.id]?.[command];if(!p)return false;if(p.users?.includes(member.id))return true;return !!member.roles?.cache?.some(r=>p.roles?.includes(r.id));}
const COMMAND_CHOICES=[["ban","حظر"],["lock","قفل"],["unlock","فتح"],["clear","مسح"],["timeout","إسكات"],["untimeout","فك الإسكات"],["unban","فك الحظر"],["logs","اللوقات"],["shortcut_add","إضافة اختصار"],["shortcut_remove","حذف اختصار"],["shortcut_list","قائمة الاختصارات"],["خط","خط"]];
const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent,GatewayIntentBits.GuildVoiceStates,GatewayIntentBits.GuildModeration],partials:[Partials.Message,Partials.Channel,Partials.User,Partials.GuildMember]});
const TYPES=[["ticket","لوق التكتات"],["messages","لوق الرسائل"],["members","لوق دخول وخروج"],["voice","لوق الصوتيات"],["actions","لوق الإجراءات"],["channels","لوق الرومات"],["roles","لوق الرتب"]];
const commands=[
 new SlashCommandBuilder().setName("ban").setDescription("حظر عضو").addUserOption(o=>o.setName("member").setDescription("العضو").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("السبب")),
 new SlashCommandBuilder().setName("lock").setDescription("قفل الروم").addChannelOption(o=>o.setName("channel").setDescription("الروم (اختياري)").addChannelTypes(ChannelType.GuildText)),
 new SlashCommandBuilder().setName("unlock").setDescription("فتح الروم").addChannelOption(o=>o.setName("channel").setDescription("الروم (اختياري)").addChannelTypes(ChannelType.GuildText)),
 new SlashCommandBuilder().setName("clear").setDescription("مسح رسائل").addIntegerOption(o=>o.setName("amount").setDescription("عدد الرسائل من 1 إلى 100").setMinValue(1).setMaxValue(100).setRequired(true)),
 new SlashCommandBuilder().setName("timeout").setDescription("إسكات عضو مؤقتاً").addUserOption(o=>o.setName("member").setDescription("العضو").setRequired(true)).addStringOption(o=>o.setName("duration").setDescription("مثال 10m أو 2h أو 1d").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("السبب")),
 new SlashCommandBuilder().setName("untimeout").setDescription("فك إسكات عضو").addUserOption(o=>o.setName("member").setDescription("العضو").setRequired(true)),
 new SlashCommandBuilder().setName("unban").setDescription("فك حظر عضو").addStringOption(o=>o.setName("user_id").setDescription("معرّف المستخدم").setRequired(true)),
 new SlashCommandBuilder().setName("logs").setDescription("إعداد رومات اللوقات"),
 new SlashCommandBuilder().setName("join").setDescription("دخول الروم الصوتي الذي أنت فيه"),
 new SlashCommandBuilder().setName("leave").setDescription("خروج من الروم الصوتي"),
 new SlashCommandBuilder().setName("shortcut_add").setDescription("إضافة رد تلقائي").addStringOption(o=>o.setName("word").setDescription("الكلمة").setRequired(true)).addStringOption(o=>o.setName("reply").setDescription("الرد").setRequired(true)),
 new SlashCommandBuilder().setName("shortcut_remove").setDescription("حذف رد تلقائي").addStringOption(o=>o.setName("word").setDescription("الكلمة").setRequired(true)),
 new SlashCommandBuilder().setName("shortcut_list").setDescription("عرض الردود التلقائية"),
 new SlashCommandBuilder().setName("allow").setDescription("فتح لوحة السماح الخاصة")
].map(x=>x.toJSON());
const label=u=>u?u.tag+" ("+u.id+")":"عضو غير معروف";
async function sendDmPanel(user,payload){try{await user.send(payload);return true;}catch{return false;}}
async function askDm(userId,data,text){dmSessions.set(userId,data);const u=await client.users.fetch(userId).catch(()=>null);if(!u)return false;return sendDmPanel(u,{content:text});}
async function log(guild,type,title,desc){const id=settings.logs[guild.id]?.[type];if(!id)return;const ch=await guild.channels.fetch(id).catch(()=>null);if(ch&&ch.isTextBased())ch.send({embeds:[new EmbedBuilder().setColor(0x648cff).setTitle(title).setDescription(String(desc||"—").slice(0,4000)).setTimestamp()]}).catch(()=>{});}
async function purgeMessages(channel,n,excludeId=null){
 const fetched=await channel.messages.fetch({limit:Math.min(100,n+(excludeId?1:0))});
 const targets=[...fetched.values()].filter(msg=>msg.id!==excludeId).slice(0,n);
 if(!targets.length)return {deleted:0,reason:"ما فيش رسائل في الروم للمسح."};
 const cutoff=Date.now()-14*24*60*60*1000;
 const recent=targets.filter(msg=>msg.createdTimestamp>cutoff);
 const old=targets.filter(msg=>msg.createdTimestamp<=cutoff);
 let count=0;
 if(recent.length){
  try{
   const deleted=await channel.bulkDelete(recent,true);
   count+=deleted.size;
  }catch{
   const results=await Promise.allSettled(recent.map(msg=>msg.delete()));
   count+=results.filter(x=>x.status==="fulfilled").length;
  }
 }
 if(old.length){
  const results=await Promise.allSettled(old.map(msg=>msg.delete()));
  count+=results.filter(x=>x.status==="fulfilled").length;
 }
 return count?{deleted:count}:{deleted:0,reason:"تعذر حذف الرسائل. تأكد أن البوت عنده صلاحية Manage Messages."};
}
function duration(s){const m=/^(\d+)(s|m|h|d)$/i.exec(s||"");if(!m)return null;const n=+m[1];if(!n||n>40320)return null;return n*({s:1000,m:60000,h:3600000,d:86400000})[m[2].toLowerCase()];}
client.once("ready",async()=>{console.log("NEXO bot online as "+client.user.tag);if(!ROLE_IDS.length)console.warn("Set ADMIN_ROLE_IDS with high-rank role IDs.");try{const rest=new REST({version:"10"}).setToken(TOKEN);await rest.put(Routes.applicationCommands(client.user.id),{body:commands});console.log("NEXO slash commands registered.");}catch(e){console.error("Slash command registration failed:",e.message);}});
client.on("messageCreate",async m=>{
 if(!m.guild||m.author.bot)return;
 const c=m.content.trim(),p=c.split(/\s+/),cmd=p[0];
 const shortcuts=settings.shortcuts[m.guild.id]||{};
 if(shortcuts[c])return m.reply(shortcuts[c]).catch(()=>{});
 if(cmd==="دخول"){const v=m.member.voice.channel;if(!v)return m.reply("خش للروم الصوتي الأول.");try{joinVoiceChannel({channelId:v.id,guildId:m.guild.id,adapterCreator:m.guild.voiceAdapterCreator,selfDeaf:true});return m.reply("دخلت معاك للروم: "+v.name);}catch{return m.reply("ما قدرتش ندخل للروم الصوتي.");}}
 if(cmd==="خروج"){const v=getVoiceConnection(m.guild.id);if(!v)return m.reply("مش داخل في روم صوتي.");v.destroy();return m.reply("طلعت من الروم الصوتي.");}
 const admin=["تف","ق","ف","م","اسكت","لوقات","اختصار"];
 if(cmd==="سماح"){if(!high(m.member,m.guild))return m.reply("أمر السماح للرتب العليا فقط.");return m.reply("باش تطلعلك لوحة السماح الخاصة بيك داخل الروم، استخدم أمر السلاش /allow.");}
 if(cmd==="خط"){if(c!=="خط")return;if(!canCommand(m.member,m.guild,"خط"))return m.reply("ما عندكش سماح لاستخدام أمر خط.");try{const gifPath=path.join(__dirname,"standard_2-3.gif");const gif=fs.readFileSync(gifPath);if(gif.length<6||gif.toString("ascii",0,3)!=="GIF"||!["87a","89a"].includes(gif.toString("ascii",3,6)))throw new Error("Local file is not a valid GIF");return m.channel.send({files:[{attachment:gif,name:"nexo-line.gif"}]});}catch(error){console.error("خط GIF error:",error.message);return m.reply("تعذر قراءة ملف الـGIF. تأكد أن standard_2-3.gif موجود بجانب ملفات البوت.");}}
 if(!admin.includes(cmd)&&!c.startsWith("فك تايم")&&!c.startsWith("فك باند"))return;
 if(!canCommand(m.member,m.guild,({"تف":"ban","ق":"lock","ف":"unlock","م":"clear","اسكت":"timeout","لوقات":"logs","اختصار":"shortcut_add"}[cmd]|| (c.startsWith("فك تايم")?"untimeout":c.startsWith("فك باند")?"unban":cmd))))return m.reply("ما عندكش سماح لاستخدام الأمر هذا.");
 
 if(cmd==="تف"){const t=m.mentions.members.first();if(!t)return m.reply("استعمال الأمر: تف @العضو [السبب]");if(!t.bannable)return m.reply("ما نقدرش نحظر العضو؛ راجع صلاحيات البوت وترتيب الرتب.");return t.ban({reason:p.slice(2).join(" ")||"بواسطة "+m.author.tag}).then(()=>m.reply("تم حظر "+t.user.tag+".")).catch(()=>m.reply("فشل الحظر."));}
 if(cmd==="ق"||cmd==="ف"){const ch=m.mentions.channels.first()||m.channel;return ch.permissionOverwrites.edit(m.guild.roles.everyone,{SendMessages:cmd==="ق"?false:null}).then(()=>m.reply(cmd==="ق"?"تم قفل الروم.":"تم فتح الروم.")).catch(()=>m.reply("فشل تعديل صلاحيات الروم."));}
 if(cmd==="م"){const n=Number(p[1]||10);if(!Number.isInteger(n)||n<1||n>100)return m.reply("اكتب عدد من 1 إلى 100. مثال: م 20");const result=await purgeMessages(m.channel,n,m.id).catch(()=>({deleted:0,reason:"تعذر جلب الرسائل."}));if(!result.deleted)return m.reply("ما تمش المسح: "+result.reason);const x=await m.channel.send("تم مسح "+result.deleted+" رسالة.").catch(()=>null);if(x)setTimeout(()=>x.delete().catch(()=>{}),4000);return;}
 if(cmd==="اسكت"){const t=m.mentions.members.first(),ms=duration(p[2]);if(!t||!ms)return m.reply("استعمال الأمر: اسكت @العضو 10m [السبب]");return t.timeout(ms,p.slice(3).join(" ")||"بواسطة "+m.author.tag).then(()=>m.reply("تم إسكات "+t.user.tag+".")).catch(()=>m.reply("فشل الإسكات."));}
 if(c.startsWith("فك تايم")){const t=m.mentions.members.first();if(!t)return m.reply("استعمال الأمر: فك تايم @العضو");return t.timeout(null,"إزالة الإسكات بواسطة "+m.author.tag).then(()=>m.reply("تم فك الإسكات.")).catch(()=>m.reply("فشل فك الإسكات."));}
 if(c.startsWith("فك باند")){const id=p[2]||p[1];if(!/^\d{17,20}$/.test(id||""))return m.reply("استعمال الأمر: فك باند ID");return m.guild.members.unban(id).then(()=>m.reply("تم فك الحظر.")).catch(()=>m.reply("ما قدرتش نفك الحظر؛ تأكد من ID."));}
 if(cmd==="لوقات"){return m.reply("باش تطلعلك لوحة اللوقات الخاصة بيك داخل الروم، استخدم أمر السلاش /logs.");}
 if(cmd==="اختصار"){const sub=p[1];if(sub==="إضافة"){const a=c.slice("اختصار إضافة".length).trim().split("|");if(a.length<2||!a[0].trim()||!a.slice(1).join("|").trim())return m.reply("استعمال: اختصار إضافة الكلمة | الرد");settings.shortcuts[m.guild.id]||={};settings.shortcuts[m.guild.id][a[0].trim()]=a.slice(1).join("|").trim();save();return m.reply("تم حفظ الاختصار.");}if(sub==="حذف"){const k=p.slice(2).join(" ");if(!shortcuts[k])return m.reply("الاختصار مش موجود.");delete shortcuts[k];save();return m.reply("تم حذف الاختصار.");}if(sub==="قائمة"){const a=Object.entries(shortcuts);return m.reply(a.length?a.map(x=>"**"+x[0]+"** ← "+x[1]).join("\n").slice(0,1900):"ما فيش اختصارات.");}return m.reply("الأوامر: اختصار إضافة الكلمة | الرد — اختصار حذف الكلمة — اختصار قائمة");}
});
client.on("interactionCreate",async i=>{
 if(!i.guild)return;
 if(i.isChatInputCommand()){
  const name=i.commandName,admin=["ban","lock","unlock","clear","timeout","untimeout","unban","logs","shortcut_add","shortcut_remove","shortcut_list"];
  const actor=await i.guild.members.fetch(i.user.id).catch(()=>null);
  if(name==="allow"){if(!high(actor,i.guild,actor?.permissions))return i.reply({content:"أمر السماح للرتب العليا فقط.",ephemeral:true});const menu=new StringSelectMenuBuilder().setCustomId("allow:command:"+i.guild.id).setPlaceholder("اختار الأمر اللي تبي تمنح صلاحية استخدامه").addOptions(COMMAND_CHOICES.map(([value,label])=>({label,value})));return i.reply({content:"**لوحة السماح** — اختار الأمر، وبعدها حدد رتبة أو شخص.",components:[new ActionRowBuilder().addComponents(menu)],ephemeral:true});}
  if(admin.includes(name)&&!canCommand(actor,i.guild,name,actor?.permissions))return i.reply({content:"ما عندكش سماح لاستخدام الأمر هذا.",ephemeral:true});
  
  if(name==="join"){const v=i.member.voice?.channel;if(!v)return i.reply({content:"خش للروم الصوتي الأول.",ephemeral:true});try{joinVoiceChannel({channelId:v.id,guildId:i.guild.id,adapterCreator:i.guild.voiceAdapterCreator,selfDeaf:true});return i.reply("دخلت معاك للروم: "+v.name);}catch{return i.reply({content:"ما قدرتش ندخل للروم الصوتي.",ephemeral:true});}}
  if(name==="leave"){const v=getVoiceConnection(i.guild.id);if(!v)return i.reply({content:"مش داخل في روم صوتي.",ephemeral:true});v.destroy();return i.reply("طلعت من الروم الصوتي.");}
  if(name==="ban"){const t=await i.guild.members.fetch(i.options.getUser("member").id).catch(()=>null);if(!t)return i.reply({content:"ما لقيتش العضو.",ephemeral:true});if(!t.bannable)return i.reply({content:"ما نقدرش نحظر العضو؛ راجع صلاحيات البوت وترتيب الرتب.",ephemeral:true});await t.ban({reason:i.options.getString("reason")||"بواسطة "+i.user.tag}).then(()=>i.reply("تم حظر "+t.user.tag+".")).catch(()=>i.reply({content:"فشل الحظر.",ephemeral:true}));return;}
  if(name==="lock"||name==="unlock"){const ch=i.options.getChannel("channel")||i.channel;return ch.permissionOverwrites.edit(i.guild.roles.everyone,{SendMessages:name==="lock"?false:null}).then(()=>i.reply(name==="lock"?"تم قفل الروم.":"تم فتح الروم.")).catch(()=>i.reply({content:"فشل تعديل صلاحيات الروم.",ephemeral:true}));}
  if(name==="clear"){const n=i.options.getInteger("amount");await i.deferReply({ephemeral:true});const result=await purgeMessages(i.channel,n).catch(()=>({deleted:0,reason:"تعذر جلب الرسائل."}));if(!result.deleted)return i.editReply("ما تمش المسح: "+result.reason);return i.editReply("تم مسح "+result.deleted+" رسالة.");}
  if(name==="timeout"){const t=await i.guild.members.fetch(i.options.getUser("member").id).catch(()=>null),ms=duration(i.options.getString("duration"));if(!t||!ms)return i.reply({content:"المدة غير صحيحة. استخدم 10m أو 2h أو 1d.",ephemeral:true});return t.timeout(ms,i.options.getString("reason")||"بواسطة "+i.user.tag).then(()=>i.reply("تم إسكات "+t.user.tag+".")).catch(()=>i.reply({content:"فشل الإسكات.",ephemeral:true}));}
  if(name==="untimeout"){const t=await i.guild.members.fetch(i.options.getUser("member").id).catch(()=>null);if(!t)return i.reply({content:"ما لقيتش العضو.",ephemeral:true});return t.timeout(null,"إزالة الإسكات بواسطة "+i.user.tag).then(()=>i.reply("تم فك الإسكات.")).catch(()=>i.reply({content:"فشل فك الإسكات.",ephemeral:true}));}
  if(name==="unban"){const id=i.options.getString("user_id");if(!/^\d{17,20}$/.test(id))return i.reply({content:"معرّف المستخدم غير صحيح.",ephemeral:true});return i.guild.members.unban(id).then(()=>i.reply("تم فك الحظر.")).catch(()=>i.reply({content:"ما قدرتش نفك الحظر؛ تأكد من المعرّف.",ephemeral:true}));}
  if(name==="logs"){const menu=new StringSelectMenuBuilder().setCustomId("logs:type:"+i.guild.id).setPlaceholder("اختار نوع اللوق").addOptions(TYPES.map(x=>({label:x[1],value:x[0]})));return i.reply({content:"**إعداد اللوقات** — اختار نوع اللوق، وبعدها اختار الروم.",components:[new ActionRowBuilder().addComponents(menu)],ephemeral:true});}
  if(name==="shortcut_add"){settings.shortcuts[i.guild.id]||={};settings.shortcuts[i.guild.id][i.options.getString("word")]=i.options.getString("reply");save();return i.reply("تم حفظ الاختصار.");}
  if(name==="shortcut_remove"){const k=i.options.getString("word"),s=settings.shortcuts[i.guild.id]||{};if(!s[k])return i.reply({content:"الاختصار مش موجود.",ephemeral:true});delete s[k];save();return i.reply("تم حذف الاختصار.");}
  if(name==="shortcut_list"){const a=Object.entries(settings.shortcuts[i.guild.id]||{});return i.reply(a.length?a.map(x=>"**"+x[0]+"** ← "+x[1]).join("\\n").slice(0,1900):"ما فيش اختصارات.");}
  return;
 }
 if(!i.isStringSelectMenu()&&!i.isChannelSelectMenu()&&!i.isRoleSelectMenu()&&!i.isUserSelectMenu())return;
 if(!high(i.member,i.guild,i.memberPermissions))return i.reply({content:"إعداد اللوقات للرتب العليا فقط.",ephemeral:true}).catch(()=>{});
 if(i.customId.startsWith("logs:type:")){
  const type=i.values[0],guildId=i.customId.split(":")[2],menu=new ChannelSelectMenuBuilder().setCustomId("logs:channel:"+guildId+":"+type).setPlaceholder("اختار روم اللوقات").setChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1);
  return i.update({content:"اختار الروم اللي تبي تربط فيه "+(TYPES.find(x=>x[0]===type)?.[1]||type)+":",components:[new ActionRowBuilder().addComponents(menu)]});
 }
 if(i.customId.startsWith("logs:channel:")){
  const parts=i.customId.split(":"),guildId=parts[2],type=parts[3],guild=await client.guilds.fetch(guildId).catch(()=>null);
  if(!guild)return i.reply({content:"السيرفر مش متاح.",ephemeral:true});
  const member=await guild.members.fetch(i.user.id).catch(()=>null);
  if(!high(member,guild,member?.permissions))return i.reply({content:"ما عندكش صلاحية إعداد اللوقات.",ephemeral:true});
  const id=i.values[0];settings.logs[guildId]||={};settings.logs[guildId][type]=id;save();
  return i.update({content:"تم ربط "+(TYPES.find(x=>x[0]===type)?.[1]||type)+" بالروم <#"+id+">.",components:[]});
 }
 if(i.customId.startsWith("allow:command:")){
  const guildId=i.customId.split(":")[2],guild=await client.guilds.fetch(guildId).catch(()=>null),member=guild?await guild.members.fetch(i.user.id).catch(()=>null):null;
  if(!guild||!high(member,guild,member?.permissions))return i.reply({content:"ما عندكش صلاحية السماح.",ephemeral:true});
  const command=i.values[0],row=new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId("allow:role:"+guildId+":"+command).setPlaceholder("اختار رتبة (اختياري)").setMinValues(0).setMaxValues(1));
  const row2=new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId("allow:user:"+guildId+":"+command).setPlaceholder("اختار شخص (اختياري)").setMinValues(0).setMaxValues(1));
  return i.update({content:"اختر الرتبة أو الشخص اللي تبي تسمحله باستخدام **"+(COMMAND_CHOICES.find(x=>x[0]===command)?.[1]||command)+"**.",components:[row,row2]});
 }
 if(i.customId.startsWith("allow:role:")||i.customId.startsWith("allow:user:")){
  const parts=i.customId.split(":"),kind=parts[1],guildId=parts[2],command=parts[3],guild=await client.guilds.fetch(guildId).catch(()=>null),member=guild?await guild.members.fetch(i.user.id).catch(()=>null):null;
  if(!guild||!high(member,guild,member?.permissions))return i.reply({content:"ما عندكش صلاحية السماح.",ephemeral:true});
  if(!i.values.length)return i.reply({content:"ما اخترتش أي رتبة أو شخص.",ephemeral:true});
  const target=i.values[0];settings.permissions[guildId]||={};settings.permissions[guildId][command]||={roles:[],users:[]};
  const entry=settings.permissions[guildId][command];
  if(kind==="role"){const role=guild.roles.cache.get(target);if(!role||role.id===guild.id||role.managed)return i.reply({content:"الرتبة غير صالحة.",ephemeral:true});if(member.id!==guild.ownerId&&member.roles.highest.comparePositionTo(role)<=0)return i.reply({content:"تقدر تمنح السماح للرتب اللي تحت رتبتك فقط.",ephemeral:true});if(!entry.roles.includes(target))entry.roles.push(target);}else{if(!entry.users.includes(target))entry.users.push(target);}
  save();return i.update({content:"تم السماح لـ "+(kind==="role"?"الرتبة":"الشخص")+" باستخدام الأمر **"+(COMMAND_CHOICES.find(x=>x[0]===command)?.[1]||command)+"**.",components:[]});
 }
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

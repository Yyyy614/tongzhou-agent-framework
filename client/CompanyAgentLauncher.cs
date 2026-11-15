using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal static class CompanyAgentLauncher {
    [STAThread] static void Main(string[] args) {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        try {
            string root=AppDomain.CurrentDomain.BaseDirectory;
            var config=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(root,"company.json")));
            string isolation="";for(int i=0;i+1<args.Length;i++)if(args[i]=="--data-dir")isolation=Path.GetFullPath(args[i+1]).ToLowerInvariant();
            string suffix; using(var hash=SHA256.Create()) suffix=BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Convert.ToString(config["serverURL"])+"|"+isolation))).Replace("-","").Substring(0,24);
            bool first; using(var mutex=new Mutex(true,"Local\\CompanyAgent-"+suffix,out first)) using(var wake=new EventWaitHandle(false,EventResetMode.AutoReset,"Local\\CompanyAgent-Wake-"+suffix)) {
                if(!first){wake.Set();return;} Application.Run(new CompanyWindow(root,suffix,wake,args));
            }
        } catch(Exception){MessageBox.Show("公司 Agent 启动未完成。请完整解压文件夹，并确认已安装 Microsoft WebView2 Runtime。","公司 Agent");}
    }
}
internal sealed class CompanyWindow:Form {
    readonly string root,suffix; readonly string[] args;
    readonly WebView2 browser=new WebView2(); readonly JavaScriptSerializer json=new JavaScriptSerializer(); readonly NotifyIcon tray=new NotifyIcon();
    RegisteredWaitHandle wakeRegistration; string origin,session; bool quitting;
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr handle,int mode);
    public CompanyWindow(string directory,string id,EventWaitHandle wake,string[] arguments){
        root=directory;suffix=id;args=arguments;Text="公司 Agent · 账号与工作中心";Width=900;Height=900;MinimumSize=new Size(680,640);StartPosition=FormStartPosition.CenterScreen;
        browser.Dock=DockStyle.Fill;Controls.Add(browser);var menu=new ContextMenuStrip();
        menu.Items.Add("我的工作与提醒",null,(s,e)=>ShowCenter());
        menu.Items.Add("打开我的工作台",null,async(s,e)=>{try{var info=await Request("open-default");if(info.ContainsKey("started")&&(bool)info["started"])FocusHarness(info);else ShowCenter();}catch{ShowCenter();}});
        menu.Items.Add("退出公司 Agent",null,async(s,e)=>{quitting=true;try{await Request("shutdown");}catch{}Close();});
        tray.Icon=SystemIcons.Application;tray.Text="公司 Agent";tray.ContextMenuStrip=menu;tray.Visible=true;tray.DoubleClick+=(s,e)=>ShowCenter();
        FormClosing+=(s,e)=>{if(!quitting){e.Cancel=true;Hide();}};
        FormClosed+=(s,e)=>{wakeRegistration.Unregister(null);tray.Dispose();browser.Dispose();};
        wakeRegistration=ThreadPool.RegisterWaitForSingleObject(wake,(s,t)=>{try{BeginInvoke(new Action(ShowCenter));}catch{}},null,Timeout.Infinite,false);
        Shown+=async(s,e)=>await Initialize();
    }
    void ShowCenter(){Show();WindowState=FormWindowState.Normal;Activate();}
    async Task<Dictionary<string,object>> Request(string action){
        using(var client=new HttpClient()){
            client.Timeout=TimeSpan.FromSeconds(90);client.DefaultRequestHeaders.Add("Origin",origin);client.DefaultRequestHeaders.Add("x-client-session",session);
            var response=await client.PostAsync(origin+"/api/"+action,new StringContent("{}",Encoding.UTF8,"application/json"));response.EnsureSuccessStatusCode();
            return json.Deserialize<Dictionary<string,object>>(await response.Content.ReadAsStringAsync());
        }
    }
    void FocusHarness(Dictionary<string,object> info){
        if(!info.ContainsKey("processId"))return;
        try{var process=Process.GetProcessById(Convert.ToInt32(info["processId"]));if(!String.Equals(process.MainModule.FileName,Path.Combine(root,"desktop","DeepSeek Harness.exe"),StringComparison.OrdinalIgnoreCase))return;
            if(process.MainWindowHandle!=IntPtr.Zero){Hide();ShowWindow(process.MainWindowHandle,9);SetForegroundWindow(process.MainWindowHandle);}}
        catch{}
    }
    async Task Initialize(){
        string handoff=Path.Combine(Path.GetTempPath(),"company-agent-"+Guid.NewGuid().ToString("N")+".json");
        try{
            string node=Path.Combine(root,"runtime","node.exe"),script=Path.Combine(root,"client","launch.mjs");if(!File.Exists(node)||!File.Exists(script))throw new Exception();
            string extra="";for(int i=0;i+1<args.Length;i++)if(args[i]=="--data-dir")extra=" --data-dir \""+Path.GetFullPath(args[i+1]).Replace("\"","")+"\"";
            var launch=new ProcessStartInfo(node,"\""+script+"\" --no-open --handoff-file \""+handoff+"\""+extra){WorkingDirectory=root,UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden};
            launch.EnvironmentVariables["NODE_USE_SYSTEM_CA"]="1";
            using(var process=Process.Start(launch)){
                Dictionary<string,object> control=null;
                for(int i=0;i<100&&control==null;i++){
                    try{if(File.Exists(handoff))control=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(handoff));}catch(IOException){}catch(ArgumentException){}
                    if(control==null){if(process.HasExited&&process.ExitCode!=0)throw new Exception();await Task.Delay(100);}
                }
                if(control==null)throw new Exception();origin=Convert.ToString(control["origin"]);session=Convert.ToString(control["session"]);
                var uri=new Uri(origin);if(uri.Scheme!="http"||uri.Host!="127.0.0.1"||uri.AbsolutePath!="/"||session.Length<32)throw new Exception();
            }
            File.Delete(handoff);
            string data=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CompanyAgentFramework","DesktopShell",suffix);
            var environment=await CoreWebView2Environment.CreateAsync(null,data);await browser.EnsureCoreWebView2Async(environment);
            browser.CoreWebView2.Settings.IsPasswordAutosaveEnabled=false;browser.CoreWebView2.Settings.IsGeneralAutofillEnabled=false;browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled=false;
            browser.CoreWebView2.NewWindowRequested+=(s,e)=>e.Handled=true;
            browser.CoreWebView2.NavigationStarting+=(s,e)=>{Uri next;if(!Uri.TryCreate(e.Uri,UriKind.Absolute,out next)||next.GetLeftPart(UriPartial.Authority)!=origin)e.Cancel=true;};
            browser.CoreWebView2.WebMessageReceived+=(s,e)=>{if(!e.Source.StartsWith(origin+"/",StringComparison.Ordinal))return;try{var message=json.Deserialize<Dictionary<string,object>>(e.TryGetWebMessageAsString());if(Convert.ToString(message["type"])=="harness.opened")FocusHarness(message);}catch{}};
            browser.Source=new Uri(origin+"/#session="+Uri.EscapeDataString(session)+"&desktop=1");
        }catch(WebView2RuntimeNotFoundException){MessageBox.Show("需要 Microsoft WebView2 Runtime 才能在软件内登录。请由公司管理员安装后重新打开；本程序不会跳转到浏览器登录。","公司 Agent");quitting=true;Close();}
        catch(Exception){MessageBox.Show("员工服务尚未就绪，请重新打开公司 Agent。详细错误位于本机应用数据目录 CompanyAgentFramework\\logs。","公司 Agent");quitting=true;Close();}
        finally{try{if(File.Exists(handoff))File.Delete(handoff);}catch(IOException){}catch(UnauthorizedAccessException){}}
    }
}

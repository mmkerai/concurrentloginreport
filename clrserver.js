// This is the node.js server file to create the 
// user login concurrency report
//****** Set up Express Server and socket.io
var http = require('http');
var https = require('https');
var app = require('express')();
var server = http.createServer(app);
var io = require('socket.io').listen(server);
var crypto = require('crypto');
var bodyParser = require('body-parser');
app.use( bodyParser.json() );       // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({     // to support URL-encoded bodies
  extended: true
})); 

//********** Get port used by Heroku or use a default
var PORT = Number(process.env.PORT || 3000);
server.listen(PORT);
console.log("Server started on port " + PORT);

//****** Callbacks for all URL requests
app.get('/', function(req, res){
	res.sendFile(__dirname + '/index.html');
});
app.get('/clrindex.js', function(req, res){
	res.sendFile(__dirname + '/clrindex.js');
});
app.get('/favicon.ico', function(req, res){
	res.sendFile(__dirname + '/favicon.ico');
});
//************** Global variables
var AID;
var SETTINGSID;
var KEY;
var GEO;		// US or EU data centre
var	OpLogins;		// array of operator logins times
var OpActivities;
var ApiDataNotReady;	// Flag to show when all Api data has been downloaded so that chat data download can begin
var ThisSocketId;
var Overall;
var FromDate;
var ToDate;
var MaxInts;	// 10,15,20,30 or 60  minute intervals in a month
var CInterval;		// login concurrency interval i.e. 10,15,20,30 or 60  minutes
var MonthIndex = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
var PreStartIgnored;
var ReportInProgress = false;
var LoginStatus = ["Logged Out","Away","Available"];	// index for StatusType field in API response

var Plogindata = function(name) {
		this.dname = name;
		this.peaks = new Array(MaxInts).fill(0);	// array of times when users are logged in
		this.peaklogins = 0;	// peak logins based on peaks array
		this.peaktime = 0;		// time of peak login
		this.peaksbyday = new Array(31).fill(0);	// array of peak login per day
};

// This class saves each JSON message returned by the getLoginActivity API call
var loginActivity = function(activity) {
	this.oid = activity.OperatorID;
	this.name = activity.Name;
	this.previousStatus = LoginStatus[activity.OriginalStatusType];	// 0 - logged out, 1 - away, 2 available
	this.newStatus = LoginStatus[activity.StatusType];
	this.created = activity.Created;
	this.ended = activity.Ended;
};

// Set up code for outbound BoldChat API calls.  All of the capture callback code should ideally be packaged as an object.
function BC_API_Request(api_method,params,callBackFunction) {
	var auth = AID + ':' + SETTINGSID + ':' + (new Date()).getTime();
	var authHash = auth + ':' + crypto.createHash('sha512').update(auth + KEY).digest('hex');
	if(GEO == "EU")
		var url = "api-eu.boldchat.com";
	else // must be US DC
		var url = "api.boldchat.com";

	var options = {
		host : url, 
		port : 443, 
		path : '/aid/'+AID+'/data/rest/json/v1/'+api_method+'?auth='+authHash+'&'+params, 
		method : 'GET'
	};
	https.request(options, callBackFunction).end();
}

function sleep(milliseconds) {
  var start = new Date().getTime();
  for(var i = 0; i < 1e7; i++) {
    if ((new Date().getTime() - start) > milliseconds){
      break;
    }
  }
}

// set up operator depts from department operators for easier indexing
function getLoginActivity() {
	if(ApiDataNotReady > 0)
	{
		console.log("Waiting for static data: "+ApiDataNotReady);
		setTimeout(getLoginActivity, 2000);
		return;
	}

	var prestart = new Date(FromDate);
	var day = prestart.getDate();
	day = day - 1;			// collect login activity 1 days before start in case person logged in
	prestart.setDate(day);
	// get all login objects using API
	getApiData("getLoginActivity", "ServiceTypeID=1&FromDate="+prestart.toISOString()+"&ToDate="+ToDate.toISOString(), loginsCallback);
	waitForLoginData();
}

// this function calls API again if data is truncated
function loadNext(method, next, callback) {
	var str = [];
	for(var key in next) {
		if (next.hasOwnProperty(key)) {
			str.push(encodeURIComponent(key) + "=" + encodeURIComponent(next[key]));
		}
	}
	sleep(500);		// to avoid too many requests at the same time which gives an API error
	getApiData(method, str.join("&"), callback);
}

// calls extraction API and receives JSON objects which are processed by the callback method
function getApiData(method, params, fcallback,cbparam) {
	ApiDataNotReady++;		// flag to track api calls
	BC_API_Request(method, params, function (response) {
		var str = '';
		//another chunk of data has been received, so append it to `str`
		response.on('data', function (chunk) {
			str += chunk;
		});
		//the whole response has been received, take final action.
		response.on('end', function () {
			ApiDataNotReady--;
			var jsonObj;
			try {
				jsonObj = JSON.parse(str);
			}
			catch (e){
				console.log("API or JSON message error: "+str);
				return;
			}
			var next = jsonObj.Next;
			var data = new Array();
			data = jsonObj.Data;
			if(data === 'undefined' || data == null)
			{
				console.log("No data returned: "+str);
				io.sockets.connected[ThisSocketId].emit('errorResponse', "Data error: "+ str);
				return;		// exit out if error json message received
			}
			fcallback(data,cbparam);

			if(typeof next !== 'undefined') 
			{
				loadNext(method, next, fcallback);
			}
		});
		// in case there is a html error
		response.on('error', function(err) {
		// handle errors with the request itself
		console.error("Error with the request: ", err.message);
		ApiDataNotReady--;
		});
	});
}

function loginsCallback(dlist) {
	var created, ended, logtime;

	for(var i in dlist) 
	{

		if(dlist[i].Ended == null)		// user must still be logged in
			ended = new Date();			// so set datetime to now
		else
			ended = new Date(dlist[i].Ended);
		
		if(ended < FromDate)			// ignore if user logged out before start date
		{
			PreStartIgnored++;
			continue;
		}
		OpActivities.push(new loginActivity(dlist[i]));		// save the activity for export later
		created = new Date(dlist[i].Created);
		if(created < FromDate)			// if user logged in before start
			created = FromDate;
			
		if(typeof(OpLogins[dlist[i].OperatorID]) === 'undefined')
		{
			OpLogins[dlist[i].OperatorID] = new Array(MaxInts).fill(0);	// array of times when user is logged in
		}
		saveLoginInfo(dlist[i].OperatorID, created, ended);		
	}

	TotalLogins = TotalLogins + dlist.length;
	io.sockets.connected[ThisSocketId].emit('messageResponse', "Login info processed: "+TotalLogins);		
}

/* // save login time span based on monthly stats (not used now)
function saveLoginInfo(opid, starttime, endtime) {
	var sd,sh,sm,ed,eh,em,sindex,eindex,count;
			
	sd = starttime.getDate();
	sh = starttime.getHours();
	sm = starttime.getMinutes();
	ed = endtime.getDate();
	eh = endtime.getHours();
	em = endtime.getMinutes();
	// date starts at 1 but array starts from 0 so make adjustment
	sd = sd - 1;
	ed = ed - 1;
	sindex = Math.floor(((sd*60*24)+(sh*60)+sm)/CInterval);		// seconds = 31 days * 24 hours * 60 min
	eindex = Math.floor(((ed*60*24)+(eh*60)+em)/CInterval);		// every 10,15,20,30 or 60  minutes
//	console.log("Logged in time "+sindex+" ,"+(eindex-sindex));
	for(count=sindex; count <= eindex; count++)
		(OpLogins[opid])[count] = 1;		// set operator logged in at this time to true
} */

// save login time span based on daily stats (update Aug 2020)
function saveLoginInfo(opid, starttime, endtime) {
	var sd,sh,sm,ed,eh,em,sindex,eindex,count;

	sh = starttime.getHours();
	sm = starttime.getMinutes();
	eh = endtime.getHours();
	em = endtime.getMinutes();

	sindex = Math.floor(((sh*60)+sm)/CInterval);		// minutes = hours * 60 min
	eindex = Math.floor(((eh*60)+em)/CInterval);		// every 10,15,20,30 or 60  minutes
//	console.log("Logged in time "+sindex+" ,"+(eindex-sindex));
	for(count=sindex; count <= eindex; count++)
		(OpLogins[opid])[count] = 1;		// set operator logged in at this time to true
}

function calculateConcLogins() {
	var count;
	
	for(var opid in OpLogins)
	{
		for(count=0; count < MaxInts; count++)
		{
			if((OpLogins[opid])[count] == 1)
			{
				Overall.peaks[count]++;
			}
		}
	}
}

/* // calculate peak logins by checking everybody logged in each minutes interval of the day 
function calculatePeakLogins() {
	var count, day, partday, hours, mins;
	for(count=0; count < MaxInts; count++)
	{
		if(Overall.peaklogins < Overall.peaks[count])
		{
			Overall.peaklogins = Overall.peaks[count];
			Overall.peaktime = count;
		}
		day = Math.floor((count*CInterval)/ (24*60));
		if(Overall.peaksbyday[day] < Overall.peaks[count])
		{
			Overall.peaksbyday[day] = Overall.peaks[count];
		}
	}
	
	day = Math.floor((Overall.peaktime *CInterval)/ (24*60)) + 1;
	partday = (Overall.peaktime*CInterval) % (24*60);
	hours = Math.floor(partday/ 60);
	mins = partday % 60;
	console.log("Peak value by interval is "+Overall.peaklogins+" at "+Overall.peaktime+"<br/>");
	console.log("datetime is "+day+" day, "+hours+" hours, "+mins+" mins<br/>");
}
 */
// calculate peak logins by checking everybody logged in each minute interval for one day 
function calculatePeakLogins() {
	var count, hours, mins;
	for(count=0; count < MaxInts; count++)
	{
		if(Overall.peaklogins < Overall.peaks[count])
		{
			Overall.peaklogins = Overall.peaks[count];
			Overall.peaktime = count;
		}
	}
	
	hours = Math.floor(Overall.peaktime*CInterval/ 60);
	mins = Overall.peaktime*CInterval % 60;
	// convert peaktime from interval to proper date
	Overall.peaktime = new Date(FromDate.getTime() + (Overall.peaktime * CInterval * 60 * 1000));
	console.log("Peak value by interval is "+Overall.peaklogins+" at "+Overall.peaktime);
	console.log("Time is "+hours+" hours, "+mins+" mins");
}

// this converts login data into a csv format 
function convertToCsv() {		
	var csvtext = "";
	var csvbyday = "";
	var dt,tm;
	var time = new Date(FromDate);
	csvtext = "Login report for "+FromDate.getDate() +" "+ MonthIndex[FromDate.getMonth()]+" "+FromDate.getFullYear()+"\r\n";
	csvtext = csvtext + "Peak Logins: "+Overall.peaklogins+",at: "+Overall.peaktime+"\r\n";
	csvbyday = csvtext;		// use same header for both files
	csvtext = csvtext + "Date,Time,Peak Logins";
	csvtext = csvtext +"\r\n";
	csvbyday = csvbyday + "Date,Peak Logins";
	csvbyday = csvbyday +"\r\n";
	
	var startmilli = time.getTime();
	
	for(var i=0; i < MaxInts; i++)
	{
		tm = new Date(startmilli + i*CInterval*60*1000);	// convert index time to milliseconds from start
		dt = tm.toISOString().slice(0,19).replace(/T/g,",");
		csvtext = csvtext + dt +","+Overall.peaks[i];
		csvtext = csvtext +"\r\n";
	}
	io.sockets.connected[ThisSocketId].emit('rep1DoneResponse', csvtext);	

	// This is for monthly so not required
/* 	var date = time.toISOString().slice(0,8);
	var day;
	for(var i=0; i < 31; i++)
	{
		day = Number(i) + Number(1);	// add one as array starts from 0
		dt = date + day;
		csvbyday = csvbyday +dt+","+Overall.peaksbyday[i];
		csvbyday = csvbyday +"\r\n";
	}
	io.sockets.connected[ThisSocketId].emit('rep2DoneResponse', csvbyday); */	
}

// Added Aug 2020
// this exports raw login activity into a csv format 
function exportToCsv() {		
	var logs = "Login Activty from " + FromDate + " to " + ToDate;
	logs = logs + "\r\n" + "Operator ID,Operator Name,Previous Status,New Status,Created,Ended";
	for(var i in OpActivities)
	{
		logs = logs + "\r\n" + "\"=\"\"" + OpActivities[i].oid + "\"\"\"," +
							OpActivities[i].name + "," +
							OpActivities[i].previousStatus + "," +
							OpActivities[i].newStatus + "," +
							OpActivities[i].created + "," +
							OpActivities[i].ended;
	}
	
	io.sockets.connected[ThisSocketId].emit('rep3DoneResponse', logs);	
}

function initialiseGlobals() {
	OpLogins = new Object();
	OpActivities = new Array();
//	MaxInts = 31*24*(60/CInterval);		// max intervals in a month 31 days * 24 hours * 4 or 6 per hour
	MaxInts = 24*(60/CInterval);		// max intervals in a day * 24 hours * 4 or 6 per hour
	ApiDataNotReady = 0;
	TotalLogins = 0;
	Overall = new Plogindata("Overall");
	FromDate = 0;
	ToDate = 0;
	PreStartIgnored = 0;
}

// Set up callbacks
io.on('connection', function(socket) {
	//  Get all reports and returned data
	socket.on('getLoginReport', function(data)
	{	
		if(ReportInProgress)
		{
			socket.emit('errorResponse', "Report already in progress, try again later");				
		}
		else
		{
			if(typeof data.ci !== 'undefined')
			{
				CInterval = Number(data.ci);
				if(CInterval !== 10 && CInterval !== 15 && CInterval !== 20 && CInterval !== 30 && CInterval !== 60)	// concurrency interval
				{
					socket.emit('errorResponse', "Concurrency interval must be 10,15,20,30 or 60  minutes");
					return;
				}
			}
			else
				CInterval = Number(15);		// default is every 15 minutes
			
			initialiseGlobals();
			GEO = data.dc || "US";		// US DC is default
			AID = data.aid || 0;
			SETTINGSID = data.settingsId || 0;
			KEY = data.apiKey || 0;
			if(AID == 0 || SETTINGSID == 0 || KEY == 0)
			{
				socket.emit('errorResponse', "Credentials not complete");
				return;
			}
			FromDate = new Date(data.fd);
			ToDate = new Date(data.td);
			var str = "Calculating concurrent logins based on "+CInterval+" min intervals from "+FromDate.toGMTString()+" to "+ToDate.toGMTString();
			socket.emit('errorResponse', str);
			console.log(str);
			ReportInProgress = true;
			ThisSocketId = socket.id;
			getLoginActivity();		// login activity for time period
		}
	});
	
	socket.on('disconnect', function(data){
		console.log("socket disconnect");
	});
	
	socket.on('end', function(data){
		console.log("socket ended");
	});

});

function waitForLoginData() {
	if(ApiDataNotReady > 0)
	{
		console.log("Logins processed: "+TotalLogins);
		setTimeout(waitForLoginData, 2000);
		return;
	}

	console.log("Calculating peak logins");
	calculateConcLogins();
	calculatePeakLogins();
	console.log("Prestart ignored is "+PreStartIgnored);
	
	io.sockets.connected[ThisSocketId].emit('loginsResponse', Overall);					
	convertToCsv();		// Concurrent login report
	exportToCsv();		// Login activity report
	ReportInProgress = false;		// reset for next user
}

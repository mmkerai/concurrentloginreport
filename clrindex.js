var socket = io.connect();

function toHHMMSS(seconds) {
    var sec_num = parseInt(seconds, 10); // don't forget the second param
    var hours   = Math.floor(sec_num / 3600);
    var minutes = Math.floor((sec_num - (hours * 3600)) / 60);
    var seconds = sec_num - (hours * 3600) - (minutes * 60);

    if (hours   < 10) {hours   = "0"+hours;}
    if (minutes < 10) {minutes = "0"+minutes;}
    if (seconds < 10) {seconds = "0"+seconds;}
    var time    = hours+':'+minutes+':'+seconds;
    return time;
}

function readCookie(name)
{
  name += '=';
  var parts = document.cookie.split(/;\s*/);
  for (var i = 0; i < parts.length; i++)
  {
    var part = parts[i];
    if (part.indexOf(name) == 0)
      return part.substring(name.length);
  }
  return null;
}

/*
 * Saves a cookie for delay time. If delay is blank then no expiry.
 * If delay is less than 100 then assumes it is days
 * otherwise assume it is in seconds
 */
function saveCookie(name, value, delay)
{
  var date, expires;
  if(delay)
  {
	  if(delay < 100)	// in days
		  delay = delay*24*60*60*1000;	// convert days to milliseconds
	  else
		  delay = delay*1000;	// seconds to milliseconds
	  
	  date = new Date();
	  date.setTime(date.getTime()+delay);	// delay must be in seconds
	  expires = "; expires=" + date.toGMTString();		// convert unix date to string
  }
  else
	  expires = "";
  
  document.cookie = name+"="+value+expires+"; path=/";
}

/*
 * Delete cookie by setting expiry to 1st Jan 1970
 */
function delCookie(name) 
{
	document.cookie = name + "=; expires=Thu, 01-Jan-70 00:00:01 GMT; path=/";
}

function clearCredentials() {
	initialiseValues();
	delCookie("username");
	delCookie("password");
	window.location.reload();
}

function initialiseValues() {
	$('#error').text("");
	$('#message').text("");
	$('#result').text("");
	$('#downloadbutton').hide();
}

$(document).ready(function() {
	var csvfile = null;
	var enddate, startdate;
	
	initialiseValues();
	
	$('#loginreportform').submit(function(event) {
		event.preventDefault();
		initialiseValues();
		var accId = $('#accountId').val();
		var apiId = $('#apiKeyId').val();
		var keyId = $('#apiKey').val();
		var month = $('#month').val();
		var year = $('#year').val();
		var cint = $('#interval').val();

		startdate = new Date();
		startdate.setYear(year);
		startdate.setMonth(month,1);
		startdate.setUTCHours(0,0,0,0);
		
		enddate = new Date();
		enddate.setYear(year);
		enddate.setMonth(parseInt(month)+1,1);
//		enddate.setMonth(month,3);			// for testing only
		enddate.setUTCHours(0,0,0,0);
		enddate = new Date(enddate.getTime() - 1);
		console.log("Start and end date: "+startdate.toDateString()+" , "+enddate.toDateString());
		var loginobj = {aid: accId, settingsId: apiId, apiKey: keyId, ci: cint, fd: startdate.toISOString(), td: enddate.toISOString()};
		socket.emit('getLoginReport', loginobj);
	});
	
	socket.on('errorResponse', function(data){
		$("#error").text(data);
	});
	socket.on('messageResponse', function(data){
		$("#message").text(data);
	});
	socket.on('operatorLoginsResponse', function(data){
		console.log("User Data received "+Object.keys(data).length);
	});
	socket.on('loginsResponse', function(data){
		var pdatetime = new Date(startdate.getTime() +(data.peaktime*10*60*1000));	// convert index to time
		console.log("Peak Login Data received "+data.peaklogins+" at "+pdatetime.toISOString());
		var str = "";
	
		str = "Peak logins: "+data.peaklogins+" on "+pdatetime.toUTCString();
		$("#result").html(str);
	});
	
	socket.on('doneResponse', function(data){
		$("#done").text("Creating csv file");
		var filedata = new Blob([data], {type: 'text/plain'});
		// If we are replacing a previously generated file we need to
		// manually revoke the object URL to avoid memory leaks.
		if (csvfile !== null)
		{
			window.URL.revokeObjectURL(csvfile);
		}
		csvfile = window.URL.createObjectURL(filedata);
		$('#downloadbutton').attr('href', csvfile);
		$('#downloadbutton').html("Download file");
		$('#downloadbutton').show(300);
	});

});



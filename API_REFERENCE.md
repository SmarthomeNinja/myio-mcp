# myIO Valet API Reference

This document describes the actual myIO Valet API endpoints based on the IO Valet-3.9+API_HU.pdf documentation.

## Base URL

The default myIO Valet API runs on port 843:
```
http://<myio-ip>:843
```

## API Endpoints (To be updated)

> **Note**: The current implementation uses placeholder REST API endpoints. These need to be updated based on the actual myIO Valet API documentation (IO Valet-3.9+API_HU.pdf).

### Current Placeholder Endpoints

The following endpoints are implemented as placeholders and may need to be updated:

- `GET /api/devices` - List all devices
- `GET /api/devices/{id}` - Get device status
- `POST /api/switch/{id}` - Set switch state
- `POST /api/relay/{id}` - Set relay state  
- `POST /api/pwm/{id}` - Set PWM value
- `GET /api/sensor/{id}` - Read sensor value

### Required Updates

To complete the API integration, the following information is needed from the official documentation:

1. **Authentication**
   - Is HTTP authentication required?
   - Username/password format?
   - API token mechanism?

2. **Endpoint Structure**
   - Exact URL patterns for each operation
   - HTTP methods (GET, POST, PUT, DELETE)
   - Request body format (JSON, form-data, query parameters)
   - Response format

3. **Device Identification**
   - How are devices identified (ID format, naming scheme)?
   - Device types and their endpoints

4. **Error Handling**
   - HTTP status codes
   - Error response format

## Integration Checklist

- [ ] Review IO Valet-3.9+API_HU.pdf documentation
- [ ] Update base URL and port configuration
- [ ] Implement authentication if required
- [ ] Update all API endpoints to match actual API
- [ ] Update request/response formats
- [ ] Add proper error handling
- [ ] Test with actual myIO hardware

## References

- Official documentation: IO Valet-3.9+API_HU.pdf
- SmartHome Ninja website: https://smarthomeninja.hu/
- Downloads page: https://smarthomeninja.hu/letoltesek/
